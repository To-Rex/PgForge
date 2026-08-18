import type { QueryHistoryEntry } from '@pgforge/shared'
import { newId, nowIso, truncate } from '../../core/util.js'
import type { MetaStore } from '../../infra/store.js'

const MAX_SQL_STORED = 10_000
const KEEP_PER_USER = 500

interface Row {
  id: string
  connection_id: string
  database: string
  sql: string
  ok: number
  error: string | null
  duration_ms: number
  row_count: number | null
  executed_at: string
}

export class HistoryRepo {
  constructor(private readonly store: MetaStore) {}

  record(entry: {
    userId: string
    connectionId: string
    database: string
    sql: string
    ok: boolean
    error: string | null
    durationMs: number
    rowCount: number | null
  }): void {
    this.store.run(
      `INSERT INTO query_history (id, user_id, connection_id, database, sql, ok, error, duration_ms, row_count, executed_at)
       VALUES (:id, :userId, :connectionId, :database, :sql, :ok, :error, :durationMs, :rowCount, :executedAt)`,
      {
        id: newId(),
        userId: entry.userId,
        connectionId: entry.connectionId,
        database: entry.database,
        sql: truncate(entry.sql, MAX_SQL_STORED),
        ok: entry.ok ? 1 : 0,
        error: entry.error ? truncate(entry.error, 2000) : null,
        durationMs: Math.round(entry.durationMs),
        rowCount: entry.rowCount,
        executedAt: nowIso(),
      },
    )
    this.store.run(
      `DELETE FROM query_history WHERE user_id = :userId AND id NOT IN (
         SELECT id FROM query_history WHERE user_id = :userId
         ORDER BY executed_at DESC LIMIT :keep)`,
      { userId: entry.userId, keep: KEEP_PER_USER },
    )
  }

  list(userId: string, connectionId: string | undefined, limit: number): QueryHistoryEntry[] {
    const rows = connectionId
      ? this.store.all<Row>(
          `SELECT * FROM query_history WHERE user_id = :userId AND connection_id = :connectionId
           ORDER BY executed_at DESC LIMIT :limit`,
          { userId, connectionId, limit },
        )
      : this.store.all<Row>(
          `SELECT * FROM query_history WHERE user_id = :userId ORDER BY executed_at DESC LIMIT :limit`,
          { userId, limit },
        )
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      database: r.database,
      sql: r.sql,
      ok: r.ok === 1,
      error: r.error,
      durationMs: r.duration_ms,
      rowCount: r.row_count,
      executedAt: r.executed_at,
    }))
  }

  clear(userId: string): void {
    this.store.run('DELETE FROM query_history WHERE user_id = :userId', { userId })
  }
}
