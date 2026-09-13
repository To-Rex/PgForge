import type pg from 'pg'
import type { AdviceItem, AdviceResponse, AdviceSeverity } from '@pgforge/shared'
import { qualify, quoteIdent } from '../../core/ident.js'
import { nowIso } from '../../core/util.js'
import type { AppContext } from '../../context.js'

const PER_KIND_LIMIT = 25
/** Below this an unused index is not worth the churn of dropping it. */
const UNUSED_INDEX_MIN_BYTES = 1024 * 1024
/** Sequential scans only matter once a table is too big to scan casually. */
const SEQ_SCAN_MIN_ROWS = 10_000
const SEQ_SCAN_MIN_COUNT = 50
const DEAD_TUPLE_MIN = 1_000
const NEVER_ANALYZED_MIN_ROWS = 1_000

const NON_SYSTEM = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'`

/**
 * Foreign keys whose referencing columns are not the leading columns of any
 * index. These make every parent delete/update a sequential scan of the child,
 * and unlike most tuning advice the fix is unambiguous.
 */
const UNINDEXED_FK_SQL = `
SELECT n.nspname AS schema, c.relname AS "table", con.conname AS constraint_name,
       ARRAY(
         SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         ORDER BY k.ord
       ) AS columns,
       pg_total_relation_size(c.oid)::text AS total_bytes,
       COALESCE(st.n_live_tup, 0)::text AS live_tuples
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
WHERE con.contype = 'f'
  AND ${NON_SYSTEM}
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = con.conrelid
      AND i.indisvalid
      AND (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(con.conkey, 1)] = con.conkey
  )
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT ${PER_KIND_LIMIT}`

const SEQ_SCAN_SQL = `
SELECT schemaname AS schema, relname AS "table",
       seq_scan::text AS seq_scan, seq_tup_read::text AS seq_tup_read,
       COALESCE(idx_scan, 0)::text AS idx_scan, n_live_tup::text AS live_tuples,
       pg_total_relation_size(relid)::text AS total_bytes
FROM pg_stat_user_tables
WHERE seq_scan > ${SEQ_SCAN_MIN_COUNT}
  AND n_live_tup > ${SEQ_SCAN_MIN_ROWS}
  AND seq_scan > COALESCE(idx_scan, 0) * 2
ORDER BY seq_tup_read DESC
LIMIT ${PER_KIND_LIMIT}`

const UNUSED_INDEX_SQL = `
SELECT n.nspname AS schema, c.relname AS "table", i.relname AS index_name,
       pg_relation_size(i.oid)::text AS index_bytes,
       s.idx_scan::text AS idx_scan
FROM pg_stat_user_indexes s
JOIN pg_class i ON i.oid = s.indexrelid
JOIN pg_class c ON c.oid = s.relid
JOIN pg_namespace n ON n.oid = i.relnamespace
JOIN pg_index ix ON ix.indexrelid = i.oid
WHERE s.idx_scan = 0
  AND NOT ix.indisunique AND NOT ix.indisprimary
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid)
  AND pg_relation_size(i.oid) > ${UNUSED_INDEX_MIN_BYTES}
  AND ${NON_SYSTEM}
ORDER BY pg_relation_size(i.oid) DESC
LIMIT ${PER_KIND_LIMIT}`

/** Same table, same access method, same columns, same predicate — one is dead weight. */
const DUPLICATE_INDEX_SQL = `
SELECT schema, "table", names, total_bytes FROM (
  SELECT n.nspname AS schema, c.relname AS "table",
         array_agg(i.relname ORDER BY pg_relation_size(i.oid) DESC, i.relname) AS names,
         sum(pg_relation_size(i.oid))::text AS total_bytes,
         count(*) AS n
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class c ON c.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  WHERE ${NON_SYSTEM} AND ix.indisvalid
  GROUP BY n.nspname, c.relname, am.amname, ix.indkey::text, ix.indclass::text,
           COALESCE(pg_get_expr(ix.indpred, ix.indrelid), ''),
           COALESCE(pg_get_expr(ix.indexprs, ix.indrelid), '')
) g
WHERE n > 1
ORDER BY total_bytes::bigint DESC
LIMIT ${PER_KIND_LIMIT}`

const BLOAT_SQL = `
SELECT schemaname AS schema, relname AS "table",
       n_dead_tup::text AS dead_tuples, n_live_tup::text AS live_tuples,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > ${DEAD_TUPLE_MIN}
  AND n_dead_tup > n_live_tup * 0.2
ORDER BY n_dead_tup DESC
LIMIT ${PER_KIND_LIMIT}`

const NEVER_ANALYZED_SQL = `
SELECT schemaname AS schema, relname AS "table", n_live_tup::text AS live_tuples
FROM pg_stat_user_tables
WHERE last_analyze IS NULL AND last_autoanalyze IS NULL
  AND n_live_tup > ${NEVER_ANALYZED_MIN_ROWS}
ORDER BY n_live_tup DESC
LIMIT ${PER_KIND_LIMIT}`

const SEVERITY_ORDER: Record<AdviceSeverity, number> = { high: 0, medium: 1, low: 2 }

function bytes(text: string): string {
  const n = Number(text)
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function count(text: string): string {
  const n = Number(text)
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'
}

export class AdviceService {
  constructor(private readonly ctx: AppContext) {}

  async advise(connId: string, db: string): Promise<AdviceResponse> {
    return this.ctx.pools.withClient(connId, db, async (client) => {
      const hasStatistics = await this.hasStatistics(client)
      const items: AdviceItem[] = [
        ...(await this.unindexedForeignKeys(client)),
        ...(await this.seqScanHeavy(client)),
        ...(await this.unusedIndexes(client)),
        ...(await this.duplicateIndexes(client)),
        ...(await this.bloat(client)),
        ...(await this.neverAnalyzed(client)),
      ]
      items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      return { items, hasStatistics, generatedAt: nowIso() }
    })
  }

  private async hasStatistics(client: pg.PoolClient): Promise<boolean> {
    const { rows } = await client.query<{ any_activity: boolean }>(
      `SELECT COALESCE(sum(seq_scan + COALESCE(idx_scan, 0)), 0) > 0 AS any_activity
       FROM pg_stat_user_tables`,
    )
    return rows[0]?.any_activity ?? false
  }

  private async unindexedForeignKeys(client: pg.PoolClient): Promise<AdviceItem[]> {
    const { rows } = await client.query<{
      schema: string
      table: string
      constraint_name: string
      columns: string[]
      total_bytes: string
      live_tuples: string
    }>(UNINDEXED_FK_SQL)
    return rows.map((r) => ({
      id: `fk:${r.schema}.${r.table}.${r.constraint_name}`,
      kind: 'unindexed_foreign_key' as const,
      // Only a large child table makes the missing index urgent.
      severity: (Number(r.live_tuples) > SEQ_SCAN_MIN_ROWS ? 'high' : 'medium') as AdviceSeverity,
      schema: r.schema,
      table: r.table,
      columns: r.columns,
      metrics: [
        { label: 'constraint', value: r.constraint_name },
        { label: 'rows', value: count(r.live_tuples) },
        { label: 'size', value: bytes(r.total_bytes) },
      ],
      sql: `CREATE INDEX ON ${qualify(r.schema, r.table)} (${r.columns.map(quoteIdent).join(', ')});`,
    }))
  }

  private async seqScanHeavy(client: pg.PoolClient): Promise<AdviceItem[]> {
    const { rows } = await client.query<{
      schema: string
      table: string
      seq_scan: string
      seq_tup_read: string
      idx_scan: string
      live_tuples: string
      total_bytes: string
    }>(SEQ_SCAN_SQL)
    return rows.map((r) => {
      const scans = Number(r.seq_scan)
      const perScan = scans > 0 ? Math.round(Number(r.seq_tup_read) / scans) : 0
      return {
        id: `seq:${r.schema}.${r.table}`,
        kind: 'seq_scan_heavy' as const,
        severity: (Number(r.live_tuples) > 1_000_000 ? 'high' : 'medium') as AdviceSeverity,
        schema: r.schema,
        table: r.table,
        columns: [],
        metrics: [
          { label: 'seq scans', value: count(r.seq_scan) },
          { label: 'index scans', value: count(r.idx_scan) },
          { label: 'rows/scan', value: count(String(perScan)) },
          { label: 'size', value: bytes(r.total_bytes) },
        ],
        // Which column to index depends on the predicates, which statistics
        // alone cannot reveal — hand the operator the query that can.
        sql: '',
      }
    })
  }

  private async unusedIndexes(client: pg.PoolClient): Promise<AdviceItem[]> {
    const { rows } = await client.query<{
      schema: string
      table: string
      index_name: string
      index_bytes: string
      idx_scan: string
    }>(UNUSED_INDEX_SQL)
    return rows.map((r) => ({
      id: `unused:${r.schema}.${r.index_name}`,
      kind: 'unused_index' as const,
      severity: 'low' as AdviceSeverity,
      schema: r.schema,
      table: r.index_name,
      columns: [],
      metrics: [
        { label: 'on table', value: r.table },
        { label: 'scans', value: count(r.idx_scan) },
        { label: 'size', value: bytes(r.index_bytes) },
      ],
      sql: `DROP INDEX ${qualify(r.schema, r.index_name)};`,
    }))
  }

  private async duplicateIndexes(client: pg.PoolClient): Promise<AdviceItem[]> {
    const { rows } = await client.query<{
      schema: string
      table: string
      names: string[]
      total_bytes: string
    }>(DUPLICATE_INDEX_SQL)
    return rows.map((r) => {
      // names is ordered largest-first; keep the first, offer to drop the rest.
      const redundant = r.names.slice(1)
      return {
        id: `dup:${r.schema}.${r.names.join('+')}`,
        kind: 'duplicate_index' as const,
        severity: 'medium' as AdviceSeverity,
        schema: r.schema,
        table: r.table,
        columns: r.names,
        metrics: [
          { label: 'indexes', value: r.names.join(', ') },
          { label: 'combined size', value: bytes(r.total_bytes) },
        ],
        sql: redundant.map((name) => `DROP INDEX ${qualify(r.schema, name)};`).join('\n'),
      }
    })
  }

  private async bloat(client: pg.PoolClient): Promise<AdviceItem[]> {
    const { rows } = await client.query<{
      schema: string
      table: string
      dead_tuples: string
      live_tuples: string
      last_vacuum: Date | null
      last_autovacuum: Date | null
    }>(BLOAT_SQL)
    return rows.map((r) => ({
      id: `bloat:${r.schema}.${r.table}`,
      kind: 'bloat' as const,
      severity: (Number(r.dead_tuples) > 100_000 ? 'medium' : 'low') as AdviceSeverity,
      schema: r.schema,
      table: r.table,
      columns: [],
      metrics: [
        { label: 'dead rows', value: count(r.dead_tuples) },
        { label: 'live rows', value: count(r.live_tuples) },
        {
          label: 'last vacuum',
          value: (r.last_autovacuum ?? r.last_vacuum)?.toISOString() ?? 'never',
        },
      ],
      sql: `VACUUM (ANALYZE) ${qualify(r.schema, r.table)};`,
    }))
  }

  private async neverAnalyzed(client: pg.PoolClient): Promise<AdviceItem[]> {
    const { rows } = await client.query<{
      schema: string
      table: string
      live_tuples: string
    }>(NEVER_ANALYZED_SQL)
    return rows.map((r) => ({
      id: `analyze:${r.schema}.${r.table}`,
      kind: 'never_analyzed' as const,
      severity: 'medium' as AdviceSeverity,
      schema: r.schema,
      table: r.table,
      columns: [],
      metrics: [{ label: 'rows', value: count(r.live_tuples) }],
      sql: `ANALYZE ${qualify(r.schema, r.table)};`,
    }))
  }
}
