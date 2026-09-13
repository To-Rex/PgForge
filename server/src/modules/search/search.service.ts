import type pg from 'pg'
import type { SearchHit, SearchKind, SearchResponse, SearchScope } from '@pgforge/shared'
import type { AppContext } from '../../context.js'

/** Server-wide search fans out one pool per database — keep the blast radius small. */
const MAX_DATABASES = 12
/** Per-database budget, so one unreachable database cannot stall the palette. */
const PER_DB_TIMEOUT_MS = 2_500
const MAX_PARALLEL = 4
const MAX_HITS = 200

/** Catalog lookup: relations, routines, schemas and columns in one round trip. */
const SEARCH_SQL = `
SELECT kind, schema, name, tbl FROM (
  SELECT CASE c.relkind
           WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view'
           WHEN 'm' THEN 'matview' WHEN 'f' THEN 'foreign' WHEN 'S' THEN 'sequence'
         END AS kind,
         n.nspname AS schema, c.relname AS name, NULL::text AS tbl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f','S')
    AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND c.relname ILIKE $1 ESCAPE '\\'
  UNION ALL
  SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
         n.nspname, p.proname, NULL
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND p.proname ILIKE $1 ESCAPE '\\'
  UNION ALL
  SELECT 'schema', n.nspname, n.nspname, NULL
  FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND n.nspname ILIKE $1 ESCAPE '\\'
  UNION ALL
  SELECT 'column', n.nspname, a.attname, c.relname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND c.relkind IN ('r','p','v','m','f')
    AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND a.attname ILIKE $1 ESCAPE '\\'
) s
LIMIT $2`

interface CatalogRow {
  kind: SearchKind
  schema: string
  name: string
  tbl: string | null
}

/** ILIKE metacharacters in user input are literal text, not wildcards. */
function likePattern(term: string): string {
  const escaped = term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  return `%${escaped}%`
}

/**
 * Exact beats prefix beats substring; relations beat the columns inside them,
 * so typing a table name does not bury it under its own column list.
 */
const KIND_WEIGHT: Record<SearchKind, number> = {
  database: 55,
  schema: 30,
  table: 50,
  view: 45,
  matview: 45,
  foreign: 40,
  sequence: 25,
  function: 35,
  procedure: 35,
  column: 10,
}

function score(term: string, hit: { name: string; kind: SearchKind }): number {
  const name = hit.name.toLowerCase()
  const needle = term.toLowerCase()
  let base: number
  if (name === needle) base = 300
  else if (name.startsWith(needle)) base = 200
  else base = 100
  // Shorter names containing the term are the more specific match.
  return base + KIND_WEIGHT[hit.kind] - Math.min(name.length, 40) / 10
}

export class SearchService {
  constructor(private readonly ctx: AppContext) {}

  async search(
    connId: string,
    opts: { q: string; scope: SearchScope; db: string; limit: number },
  ): Promise<SearchResponse> {
    const started = Date.now()
    const term = opts.q.trim()
    if (term.length === 0) {
      return { hits: [], skipped: [], truncated: false, durationMs: 0 }
    }

    const skipped: string[] = []
    const hits: SearchHit[] = []

    const databases =
      opts.scope === 'server' ? await this.connectableDatabases(connId, skipped) : [opts.db]

    // Database names themselves are worth matching — typing "analytics" should
    // offer the database before anything inside it.
    if (opts.scope === 'server') {
      for (const name of databases) {
        if (name.toLowerCase().includes(term.toLowerCase())) {
          hits.push({
            database: name,
            schema: null,
            name,
            kind: 'database',
            table: null,
            score: score(term, { name, kind: 'database' }),
          })
        }
      }
    }

    const pattern = likePattern(term)
    const perDbLimit = Math.max(20, Math.ceil(opts.limit / Math.max(databases.length, 1)) * 4)

    for (let i = 0; i < databases.length; i += MAX_PARALLEL) {
      const batch = databases.slice(i, i + MAX_PARALLEL)
      const settled = await Promise.allSettled(
        batch.map((name) => this.searchOne(connId, name, pattern, perDbLimit)),
      )
      settled.forEach((result, j) => {
        const name = batch[j]!
        if (result.status === 'rejected') {
          skipped.push(name)
          return
        }
        for (const row of result.value) {
          if (!row.kind) continue
          hits.push({
            database: name,
            schema: row.schema,
            name: row.name,
            kind: row.kind,
            table: row.tbl,
            score: score(term, { name: row.name, kind: row.kind }),
          })
        }
      })
    }

    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    const truncated = hits.length > opts.limit
    return {
      hits: hits.slice(0, opts.limit),
      skipped,
      truncated,
      durationMs: Date.now() - started,
    }
  }

  private searchOne(
    connId: string,
    db: string,
    pattern: string,
    limit: number,
  ): Promise<CatalogRow[]> {
    return this.ctx.pools.withClient(connId, db, async (client: pg.PoolClient) => {
      await client.query(`SET statement_timeout = ${PER_DB_TIMEOUT_MS}`)
      try {
        const { rows } = await client.query<CatalogRow>(SEARCH_SQL, [pattern, limit])
        return rows
      } finally {
        await client.query('RESET statement_timeout').catch(() => {})
      }
    })
  }

  /** Databases this role can actually open, capped so a big server stays usable. */
  private async connectableDatabases(connId: string, skipped: string[]): Promise<string[]> {
    const names = await this.ctx.pools.withClient(connId, undefined, async (client) => {
      const { rows } = await client.query<{ name: string }>(`
        SELECT datname AS name
        FROM pg_database
        WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
        ORDER BY pg_database_size(datname) DESC`)
      return rows.map((r) => r.name)
    })
    if (names.length > MAX_DATABASES) {
      skipped.push(...names.slice(MAX_DATABASES))
      return names.slice(0, MAX_DATABASES)
    }
    return names
  }
}

export const SEARCH_MAX_HITS = MAX_HITS
