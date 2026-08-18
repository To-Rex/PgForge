import pg from 'pg'
import Cursor from 'pg-cursor'
import type {
  ExplainResponse,
  SqlErrorInfo,
  SqlRequest,
  SqlResponse,
  StatementResult,
} from '@pgforge/shared'
import { BadRequestError, ForbiddenError, isPgError } from '../../core/errors.js'
import { firstKeyword, isReadOnlyStatement, splitSqlStatements } from '../../core/sql-split.js'
import { toJsonSafe } from '../../core/util.js'
import type { AppContext } from '../../context.js'
import type { HistoryRepo } from './history.repo.js'

interface RunningExec {
  connectionId: string
  backendPid: number
}

const CURSOR_KEYWORDS = new Set(['select', 'with', 'values', 'table', 'show'])

export class SqlService {
  private readonly running = new Map<string, RunningExec>()

  constructor(
    private readonly ctx: AppContext,
    private readonly history: HistoryRepo,
  ) {}

  async execute(
    connId: string,
    db: string,
    user: { id: string; readOnly: boolean },
    req: SqlRequest,
  ): Promise<SqlResponse> {
    const statements = splitSqlStatements(req.sql)
    if (statements.length === 0) throw new BadRequestError('No SQL statements to execute')

    const connection = this.ctx.resolveConnection(connId)
    const readOnly = user.readOnly || connection.readOnly
    if (readOnly) {
      for (const stmt of statements) {
        if (!isReadOnlyStatement(stmt.text)) {
          throw new ForbiddenError(
            `Read-only access: statement starting with '${firstKeyword(stmt.text) || '?'}' is not allowed`,
          )
        }
      }
    }

    const maxRows = Math.min(req.maxRows ?? this.ctx.config.sql.maxRows, this.ctx.config.sql.maxRows)
    const timeoutMs = Math.min(
      req.timeoutMs ?? this.ctx.config.sql.defaultTimeoutMs,
      this.ctx.config.sql.maxTimeoutMs,
    )

    const startedAt = Date.now()
    const notices: string[] = []
    const results: StatementResult[] = []
    let error: SqlErrorInfo | undefined

    try {
      await this.ctx.pools.withClient(connId, db, async (client) => {
        const backendPid = (client as pg.PoolClient & { processID?: number }).processID
        if (backendPid) this.running.set(req.execId, { connectionId: connId, backendPid })

        const onNotice = (notice: { message?: string }) => {
          if (notice.message && notices.length < 50) notices.push(notice.message)
        }
        client.on('notice', onNotice)
        try {
          await client.query(`SET statement_timeout = ${Math.floor(timeoutMs)}`)
          if (statements.length === 1 && CURSOR_KEYWORDS.has(firstKeyword(statements[0]!.text))) {
            results.push(
              await this.executeWithCursor(client, statements[0]!.text, maxRows, readOnly),
            )
          } else {
            results.push(...(await this.executeScript(client, req.sql, statements.length, maxRows, readOnly)))
          }
        } catch (err) {
          error = this.toSqlError(err)
          if (readOnly) await client.query('ROLLBACK').catch(() => {})
        } finally {
          client.removeListener('notice', onNotice)
          await client.query('RESET statement_timeout').catch(() => {})
          this.running.delete(req.execId)
        }
      })
    } catch (err) {
      // Pool/connection-level failure (checkout, network) — not a SQL error.
      this.running.delete(req.execId)
      throw err
    }

    const totalDurationMs = Date.now() - startedAt
    this.history.record({
      userId: user.id,
      connectionId: connId,
      database: db,
      sql: req.sql,
      ok: !error,
      error: error?.message ?? null,
      durationMs: totalDurationMs,
      rowCount: results.reduce((n, r) => n + (r.rowCount ?? 0), 0),
    })
    return { ok: !error, results, error, notices, totalDurationMs }
  }

  /** Single SELECT-like statement: extended protocol + cursor caps memory. */
  private async executeWithCursor(
    client: pg.PoolClient,
    sql: string,
    maxRows: number,
    readOnly: boolean,
  ): Promise<StatementResult> {
    const started = Date.now()
    if (readOnly) await client.query('BEGIN READ ONLY')
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }))
    try {
      const { rows, fields } = await new Promise<{
        rows: unknown[][]
        fields: pg.FieldDef[]
      }>((resolve, reject) => {
        cursor.read(maxRows + 1, (err, cursorRows, result) => {
          if (err) reject(err)
          else resolve({ rows: cursorRows as unknown[][], fields: result?.fields ?? [] })
        })
      })
      const truncated = rows.length > maxRows
      const kept = truncated ? rows.slice(0, maxRows) : rows
      if (readOnly) await client.query('COMMIT')
      return {
        command: 'SELECT',
        rowCount: kept.length,
        fields: fields.map((f) => ({ name: f.name, dataType: typeNameFromOid(f.dataTypeID) })),
        rows: kept.map((row) => row.map(toJsonSafe)),
        durationMs: Date.now() - started,
        truncated,
      }
    } finally {
      await cursor.close().catch(() => {})
    }
  }

  /**
   * Scripts / non-SELECT statements: simple query protocol. A multi-statement
   * simple query runs in one implicit transaction — atomic by default.
   */
  private async executeScript(
    client: pg.PoolClient,
    sql: string,
    statementCount: number,
    maxRows: number,
    readOnly: boolean,
  ): Promise<StatementResult[]> {
    const started = Date.now()
    const text = readOnly ? `BEGIN READ ONLY;\n${sql}\n;COMMIT;` : sql
    const raw = await client.query({ text, rowMode: 'array' } as pg.QueryConfig)
    const all = (Array.isArray(raw) ? raw : [raw]) as pg.QueryArrayResult[]
    const durationMs = Date.now() - started
    const perStatement = durationMs / Math.max(statementCount, 1)
    return all
      .filter((r) => {
        const cmd = r.command?.toUpperCase() ?? ''
        // Hide the synthetic wrapper transaction from results.
        return !(readOnly && (cmd === 'BEGIN' || cmd === 'COMMIT'))
      })
      .map((r) => {
        const rows = (r.rows ?? []) as unknown[][]
        const truncated = rows.length > maxRows
        const kept = truncated ? rows.slice(0, maxRows) : rows
        return {
          command: r.command ?? '',
          rowCount: r.rowCount,
          fields: (r.fields ?? []).map((f) => ({
            name: f.name,
            dataType: typeNameFromOid(f.dataTypeID),
          })),
          rows: kept.map((row) => row.map(toJsonSafe)),
          durationMs: Math.round(perStatement),
          truncated,
        }
      })
  }

  async explain(
    connId: string,
    db: string,
    user: { readOnly: boolean },
    sql: string,
    analyze: boolean,
  ): Promise<ExplainResponse> {
    const statements = splitSqlStatements(sql)
    if (statements.length !== 1) {
      throw new BadRequestError('EXPLAIN accepts exactly one statement')
    }
    const stmt = statements[0]!.text
    const connection = this.ctx.resolveConnection(connId)
    const readOnly = user.readOnly || connection.readOnly
    if (readOnly && !isReadOnlyStatement(stmt)) {
      throw new ForbiddenError('Read-only access: cannot explain a write statement')
    }
    const options = ['FORMAT JSON', 'VERBOSE']
    if (analyze) options.push('ANALYZE', 'BUFFERS')
    const started = Date.now()
    return this.ctx.pools.withClient(connId, db, async (client) => {
      await client.query(`SET statement_timeout = ${this.ctx.config.sql.maxTimeoutMs}`)
      try {
        if (readOnly) await client.query('BEGIN READ ONLY')
        const result = await client.query(`EXPLAIN (${options.join(', ')}) ${stmt}`)
        if (readOnly) await client.query('COMMIT')
        const first = result.rows[0] as Record<string, unknown> | undefined
        return {
          plan: first?.['QUERY PLAN'] ?? null,
          durationMs: Date.now() - started,
        }
      } catch (err) {
        if (readOnly) await client.query('ROLLBACK').catch(() => {})
        const sqlError = this.toSqlError(err)
        throw new BadRequestError(sqlError.message, sqlError)
      } finally {
        await client.query('RESET statement_timeout').catch(() => {})
      }
    })
  }

  /** Cancels a running execution via pg_cancel_backend from a fresh client. */
  async cancel(connId: string, execId: string): Promise<boolean> {
    const exec = this.running.get(execId)
    if (!exec || exec.connectionId !== connId) return false
    const resolved = this.ctx.resolveConnection(connId)
    const client = new pg.Client({
      host: resolved.host,
      port: resolved.port,
      user: resolved.username,
      password: resolved.password,
      database: resolved.defaultDatabase,
      connectionTimeoutMillis: 5000,
      application_name: 'pgforge-cancel',
    })
    try {
      await client.connect()
      await client.query('SELECT pg_cancel_backend($1)', [exec.backendPid])
      return true
    } finally {
      await client.end().catch(() => {})
    }
  }

  private toSqlError(err: unknown): SqlErrorInfo {
    if (isPgError(err)) {
      return {
        message: err.message,
        code: err.code,
        detail: err.detail,
        hint: err.hint,
        position: err.position ? Number(err.position) : undefined,
      }
    }
    return { message: err instanceof Error ? err.message : 'Query failed' }
  }
}

const OID_NAMES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1083: 'time',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  1007: 'int4[]',
  1009: 'text[]',
  1015: 'varchar[]',
}

function typeNameFromOid(oid: number): string {
  return OID_NAMES[oid] ?? `oid:${oid}`
}
