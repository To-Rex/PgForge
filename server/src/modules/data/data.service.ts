import type pg from 'pg'
import Cursor from 'pg-cursor'
import type {
  DeleteRowsRequest,
  InsertRowRequest,
  RowsPage,
  RowsQuery,
  RowValues,
  TableExportRequest,
  UpdateRowRequest,
} from '@pgforge/shared'
import { parseCsv } from '../../core/csv.js'
import { BadRequestError, ConflictError } from '../../core/errors.js'
import { qualify, quoteIdent } from '../../core/ident.js'
import { toJsonSafe } from '../../core/util.js'
import type { AppContext } from '../../context.js'
import type { InspectorService } from '../inspector/inspector.service.js'
import { buildOrderBy, buildWhere, type ColumnMeta } from './filter-builder.js'

const MAX_PAGE_SIZE = 500
const ESTIMATE_THRESHOLD = 100_000
const EXPORT_BATCH = 1_000
const EXPORT_MAX_ROWS = 1_000_000

/** Normalize JSON body values into safe node-postgres parameters. */
function toParam(value: unknown): unknown {
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return value
}

export class DataService {
  constructor(
    private readonly ctx: AppContext,
    private readonly inspector: InspectorService,
  ) {}

  queryRows(
    connId: string,
    db: string,
    schema: string,
    table: string,
    q: RowsQuery,
  ): Promise<RowsPage> {
    const pageSize = Math.min(Math.max(q.pageSize, 1), MAX_PAGE_SIZE)
    const page = Math.max(q.page, 0)
    return this.ctx.pools.withClient(connId, db, async (client) => {
      const startedAt = Date.now()
      const columns = await this.inspector.getColumns(client, schema, table)
      if (columns.length === 0) throw new BadRequestError(`Relation ${schema}.${table} not found`)
      const primaryKey = await this.inspector.getPrimaryKey(client, schema, table)
      const meta: ColumnMeta[] = columns.map((c) => ({ name: c.name, dataType: c.dataType }))
      const where = buildWhere(q.filters ?? [], q.search, meta)
      const orderBy = buildOrderBy(q.sorts ?? [], meta)
      const target = qualify(schema, table)

      let total: number
      let totalIsEstimate = false
      const hasNarrowing = where.params.length > 0 || where.clause.length > 0
      if (!hasNarrowing) {
        const est = await client.query(
          `SELECT greatest(reltuples, 0)::bigint::text AS estimate FROM pg_class WHERE oid = to_regclass($1)`,
          [target],
        )
        const estimate = Number(est.rows[0]?.estimate ?? 0)
        if (estimate > ESTIMATE_THRESHOLD) {
          total = estimate
          totalIsEstimate = true
        } else {
          const count = await client.query(`SELECT count(*)::text AS n FROM ${target}`)
          total = Number(count.rows[0]?.n ?? 0)
        }
      } else {
        const count = await client.query(
          `SELECT count(*)::text AS n FROM ${target} ${where.clause}`,
          where.params,
        )
        total = Number(count.rows[0]?.n ?? 0)
      }

      const result = await client.query({
        text: `SELECT * FROM ${target} ${where.clause} ${orderBy} LIMIT ${pageSize} OFFSET ${page * pageSize}`,
        values: where.params,
        rowMode: 'array',
      })
      return {
        columns: result.fields.map((f) => ({
          name: f.name,
          dataType: meta.find((m) => m.name === f.name)?.dataType ?? `oid:${f.dataTypeID}`,
        })),
        rows: (result.rows as unknown[][]).map((row) => row.map(toJsonSafe)),
        total,
        totalIsEstimate,
        primaryKey,
        editable: primaryKey.length > 0,
        durationMs: Date.now() - startedAt,
      }
    })
  }

  insertRow(
    connId: string,
    db: string,
    schema: string,
    table: string,
    req: InsertRowRequest,
  ): Promise<void> {
    return this.ctx.pools.withClient(connId, db, async (client) => {
      const columns = await this.inspector.getColumns(client, schema, table)
      const known = new Set(columns.map((c) => c.name))
      const entries = Object.entries(req.values).filter(([, v]) => v !== undefined)
      if (entries.length === 0) {
        await client.query(`INSERT INTO ${qualify(schema, table)} DEFAULT VALUES`)
        return
      }
      for (const [name] of entries) {
        if (!known.has(name)) throw new BadRequestError(`Unknown column: ${name}`)
      }
      const names = entries.map(([name]) => quoteIdent(name)).join(', ')
      const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ')
      await client.query(
        `INSERT INTO ${qualify(schema, table)} (${names}) VALUES (${placeholders})`,
        entries.map(([, v]) => toParam(v)),
      )
    })
  }

  updateRow(
    connId: string,
    db: string,
    schema: string,
    table: string,
    req: UpdateRowRequest,
  ): Promise<void> {
    return this.ctx.pools.withClient(connId, db, async (client) => {
      const { setClauses, whereClauses, params } = await this.buildPkMutation(
        client,
        schema,
        table,
        req.pk,
        req.changes,
      )
      const result = await client.query(
        `UPDATE ${qualify(schema, table)} SET ${setClauses} WHERE ${whereClauses}`,
        params,
      )
      if (result.rowCount !== 1) {
        throw new ConflictError(
          `Expected to update exactly 1 row, matched ${result.rowCount ?? 0}. The row may have been modified elsewhere.`,
        )
      }
    })
  }

  deleteRows(
    connId: string,
    db: string,
    schema: string,
    table: string,
    req: DeleteRowsRequest,
  ): Promise<number> {
    if (req.pks.length === 0 || req.pks.length > 1000) {
      throw new BadRequestError('Delete between 1 and 1000 rows per request')
    }
    return this.ctx.pools.withClient(connId, db, async (client) => {
      const primaryKey = await this.inspector.getPrimaryKey(client, schema, table)
      if (primaryKey.length === 0) {
        throw new BadRequestError('Table has no primary key; delete rows via the SQL editor instead')
      }
      await client.query('BEGIN')
      try {
        let deleted = 0
        for (const pk of req.pks) {
          const { clause, params } = this.pkWhere(primaryKey, pk)
          const result = await client.query(
            `DELETE FROM ${qualify(schema, table)} WHERE ${clause}`,
            params,
          )
          deleted += result.rowCount ?? 0
        }
        if (deleted !== req.pks.length) {
          throw new ConflictError(
            `Expected to delete ${req.pks.length} rows but matched ${deleted}; rolled back.`,
          )
        }
        await client.query('COMMIT')
        return deleted
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    })
  }

  /** Streams filtered table data as CSV or JSON without buffering the table. */
  async export(
    connId: string,
    db: string,
    schema: string,
    table: string,
    req: TableExportRequest,
    write: (chunk: string) => Promise<void>,
  ): Promise<number> {
    const limit = Math.min(req.limit ?? EXPORT_MAX_ROWS, EXPORT_MAX_ROWS)
    return this.ctx.pools.withClient(connId, db, async (client) => {
      const columns = await this.inspector.getColumns(client, schema, table)
      if (columns.length === 0) throw new BadRequestError(`Relation ${schema}.${table} not found`)
      const meta: ColumnMeta[] = columns.map((c) => ({ name: c.name, dataType: c.dataType }))
      const where = buildWhere(req.filters ?? [], undefined, meta)
      const orderBy = buildOrderBy(req.sorts ?? [], meta)
      const cursor = client.query(
        new Cursor(
          `SELECT * FROM ${qualify(schema, table)} ${where.clause} ${orderBy} LIMIT ${limit}`,
          where.params,
          { rowMode: 'array' },
        ),
      )
      const names = columns.map((c) => c.name)
      let count = 0
      try {
        if (req.format === 'csv') {
          await write(`${names.map(csvEscape).join(',')}\n`)
          for (;;) {
            const rows = (await cursor.read(EXPORT_BATCH)) as unknown[][]
            if (rows.length === 0) break
            const block = rows
              .map((row) => row.map((v) => csvEscape(csvValue(toJsonSafe(v)))).join(','))
              .join('\n')
            await write(`${block}\n`)
            count += rows.length
          }
        } else {
          await write('[')
          for (;;) {
            const rows = (await cursor.read(EXPORT_BATCH)) as unknown[][]
            if (rows.length === 0) break
            const block = rows
              .map((row) => {
                const obj: Record<string, unknown> = {}
                names.forEach((name, i) => (obj[name] = toJsonSafe(row[i])))
                return (count++ > 0 ? ',' : '') + JSON.stringify(obj)
              })
              .join('')
            await write(block)
          }
          await write(']')
        }
      } finally {
        await cursor.close().catch(() => {})
      }
      return count
    })
  }

  /**
   * CSV import: first row must be a header naming existing columns.
   * Empty fields become NULL (matching this tool's CSV export). All rows are
   * inserted in one transaction — any bad row rolls everything back.
   */
  importCsv(
    connId: string,
    db: string,
    schema: string,
    table: string,
    csvText: string,
    delimiter: string,
  ): Promise<number> {
    const rows = parseCsv(csvText, delimiter)
    if (rows.length < 2) {
      throw new BadRequestError('CSV must contain a header row and at least one data row')
    }
    const header = rows[0]!
    const dataRows = rows.slice(1)
    return this.ctx.pools.withClient(connId, db, async (client) => {
      const known = new Set((await this.inspector.getColumns(client, schema, table)).map((c) => c.name))
      for (const column of header) {
        if (!known.has(column)) {
          throw new BadRequestError(`CSV header references unknown column: ${column}`)
        }
      }
      const names = header.map(quoteIdent).join(', ')
      const target = qualify(schema, table)
      const BATCH = 200
      let inserted = 0
      await client.query('BEGIN')
      try {
        for (let offset = 0; offset < dataRows.length; offset += BATCH) {
          const batch = dataRows.slice(offset, offset + BATCH)
          const params: unknown[] = []
          const tuples = batch.map((row, rowIdx) => {
            if (row.length !== header.length) {
              throw new BadRequestError(
                `Row ${offset + rowIdx + 2} has ${row.length} fields, expected ${header.length}`,
              )
            }
            const placeholders = row.map((value) => {
              params.push(value === '' ? null : value)
              return `$${params.length}`
            })
            return `(${placeholders.join(', ')})`
          })
          const result = await client.query(
            `INSERT INTO ${target} (${names}) VALUES ${tuples.join(', ')}`,
            params,
          )
          inserted += result.rowCount ?? 0
        }
        await client.query('COMMIT')
        return inserted
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    })
  }

  private async buildPkMutation(
    client: pg.PoolClient,
    schema: string,
    table: string,
    pk: RowValues,
    changes: RowValues,
  ): Promise<{ setClauses: string; whereClauses: string; params: unknown[] }> {
    const columns = await this.inspector.getColumns(client, schema, table)
    const known = new Set(columns.map((c) => c.name))
    const primaryKey = await this.inspector.getPrimaryKey(client, schema, table)
    if (primaryKey.length === 0) {
      throw new BadRequestError('Table has no primary key; edit rows via the SQL editor instead')
    }
    const changeEntries = Object.entries(changes).filter(([, v]) => v !== undefined)
    if (changeEntries.length === 0) throw new BadRequestError('No changes provided')
    for (const [name] of changeEntries) {
      if (!known.has(name)) throw new BadRequestError(`Unknown column: ${name}`)
    }
    const params: unknown[] = []
    const setClauses = changeEntries
      .map(([name, value]) => {
        params.push(toParam(value))
        return `${quoteIdent(name)} = $${params.length}`
      })
      .join(', ')
    const where = this.pkWhere(primaryKey, pk, params.length)
    return { setClauses, whereClauses: where.clause, params: [...params, ...where.params] }
  }

  private pkWhere(
    primaryKey: string[],
    pk: RowValues,
    offset = 0,
  ): { clause: string; params: unknown[] } {
    const params: unknown[] = []
    const clause = primaryKey
      .map((name) => {
        if (!(name in pk)) throw new BadRequestError(`Missing primary key value: ${name}`)
        params.push(toParam(pk[name]))
        return `${quoteIdent(name)} = $${offset + params.length}`
      })
      .join(' AND ')
    return { clause, params }
  }
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}
