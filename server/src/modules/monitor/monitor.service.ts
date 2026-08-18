import type {
  DbStats,
  LockInfo,
  SessionInfo,
  SlowQueriesResponse,
  TableStat,
} from '@pgforge/shared'
import type { AppContext } from '../../context.js'

export class MonitorService {
  constructor(private readonly ctx: AppContext) {}

  sessions(connId: string): Promise<SessionInfo[]> {
    return this.ctx.pools.withClient(connId, undefined, async (c) => {
      const { rows } = await c.query(`
        SELECT pid, usename AS user, datname AS database,
               COALESCE(application_name, '') AS application_name,
               client_addr::text AS client_addr, state, wait_event_type, wait_event,
               backend_start, query_start, state_change, COALESCE(query, '') AS query,
               CASE WHEN query_start IS NOT NULL
                    THEN (extract(epoch FROM now() - query_start) * 1000)::bigint::text END AS query_duration_ms
        FROM pg_stat_activity
        WHERE backend_type = 'client backend'
        ORDER BY backend_start`)
      return rows.map((r) => ({
        pid: r.pid,
        user: r.user,
        database: r.database,
        applicationName: r.application_name,
        clientAddr: r.client_addr,
        state: r.state,
        waitEventType: r.wait_event_type,
        waitEvent: r.wait_event,
        backendStart: iso(r.backend_start),
        queryStart: isoOrNull(r.query_start),
        stateChange: isoOrNull(r.state_change),
        query: r.query,
        queryDurationMs: r.query_duration_ms === null ? null : Number(r.query_duration_ms),
      }))
    })
  }

  async signalBackend(connId: string, pid: number, action: 'cancel' | 'terminate'): Promise<boolean> {
    const fn = action === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'
    return this.ctx.pools.withClient(connId, undefined, async (c) => {
      const { rows } = await c.query(`SELECT ${fn}($1) AS ok`, [pid])
      return rows[0]?.ok === true
    })
  }

  locks(connId: string): Promise<LockInfo[]> {
    return this.ctx.pools.withClient(connId, undefined, async (c) => {
      const { rows } = await c.query(`
        SELECT l.pid, l.locktype,
               CASE WHEN l.relation IS NOT NULL THEN l.relation::regclass::text END AS relation,
               l.mode, l.granted, a.usename AS user, a.query,
               CASE WHEN NOT l.granted THEN pg_blocking_pids(l.pid) ELSE '{}'::int[] END AS blocked_by
        FROM pg_locks l
        LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.pid <> pg_backend_pid()
        ORDER BY l.granted ASC, l.pid`)
      return rows.map((r) => ({
        pid: r.pid,
        lockType: r.locktype,
        relation: r.relation,
        mode: r.mode,
        granted: r.granted,
        user: r.user,
        query: r.query,
        blockedBy: r.blocked_by ?? [],
      }))
    })
  }

  dbStats(connId: string, db: string): Promise<DbStats> {
    return this.ctx.pools.withClient(connId, db, async (c) => {
      const { rows } = await c.query(`
        SELECT pg_database_size(current_database())::text AS size_bytes,
               s.xact_commit::text AS commits, s.xact_rollback::text AS rollbacks,
               s.blks_read::text AS blks_read, s.blks_hit::text AS blks_hit,
               s.tup_returned::text AS tup_returned, s.tup_fetched::text AS tup_fetched,
               s.tup_inserted::text AS tup_inserted, s.tup_updated::text AS tup_updated,
               s.tup_deleted::text AS tup_deleted, s.deadlocks::text AS deadlocks,
               s.temp_files::text AS temp_files, s.temp_bytes::text AS temp_bytes,
               s.stats_reset,
               (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS active,
               current_setting('max_connections')::int AS max_conn,
               (SELECT count(*) FROM pg_stat_activity
                 WHERE backend_type = 'client backend')::int AS s_total,
               (SELECT count(*) FROM pg_stat_activity
                 WHERE backend_type = 'client backend' AND state = 'active')::int AS s_active,
               (SELECT count(*) FROM pg_stat_activity
                 WHERE backend_type = 'client backend' AND state = 'idle')::int AS s_idle,
               (SELECT count(*) FROM pg_stat_activity
                 WHERE backend_type = 'client backend' AND state LIKE 'idle in transaction%')::int AS s_idle_tx,
               (SELECT count(*) FROM pg_locks)::int AS locks_total,
               (SELECT count(*) FROM pg_locks WHERE NOT granted)::int AS locks_waiting
        FROM pg_stat_database s
        WHERE s.datname = current_database()`)
      const r = rows[0]
      const hit = Number(r.blks_hit)
      const read = Number(r.blks_read)
      return {
        sizeBytes: Number(r.size_bytes),
        cacheHitRatio: hit + read > 0 ? hit / (hit + read) : null,
        commits: Number(r.commits),
        rollbacks: Number(r.rollbacks),
        tupReturned: Number(r.tup_returned),
        tupFetched: Number(r.tup_fetched),
        tupInserted: Number(r.tup_inserted),
        tupUpdated: Number(r.tup_updated),
        tupDeleted: Number(r.tup_deleted),
        deadlocks: Number(r.deadlocks),
        tempFiles: Number(r.temp_files),
        tempBytes: Number(r.temp_bytes),
        statsReset: isoOrNull(r.stats_reset),
        activeConnections: r.active,
        maxConnections: r.max_conn,
        blksRead: Number(r.blks_read),
        blksHit: Number(r.blks_hit),
        sessionsTotal: r.s_total,
        sessionsActive: r.s_active,
        sessionsIdle: r.s_idle,
        sessionsIdleInTx: r.s_idle_tx,
        locksTotal: r.locks_total,
        locksWaiting: r.locks_waiting,
      }
    })
  }

  tableStats(connId: string, db: string): Promise<TableStat[]> {
    return this.ctx.pools.withClient(connId, db, async (c) => {
      const { rows } = await c.query(`
        SELECT schemaname AS schema, relname AS name,
               seq_scan::text AS seq_scans, COALESCE(idx_scan, 0)::text AS idx_scans,
               n_live_tup::text AS live_tuples, n_dead_tup::text AS dead_tuples,
               last_vacuum, last_autovacuum, last_analyze,
               pg_total_relation_size(relid)::text AS total_bytes
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 100`)
      return rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        seqScans: Number(r.seq_scans),
        idxScans: Number(r.idx_scans),
        liveTuples: Number(r.live_tuples),
        deadTuples: Number(r.dead_tuples),
        lastVacuum: isoOrNull(r.last_vacuum),
        lastAutovacuum: isoOrNull(r.last_autovacuum),
        lastAnalyze: isoOrNull(r.last_analyze),
        totalBytes: Number(r.total_bytes),
      }))
    })
  }

  slowQueries(connId: string, db: string): Promise<SlowQueriesResponse> {
    return this.ctx.pools.withClient(connId, db, async (c) => {
      const ext = await c.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'",
      )
      if (ext.rowCount === 0) return { available: false, queries: [] }
      try {
        const { rows } = await c.query(`
          SELECT query, calls::text AS calls, total_exec_time, mean_exec_time, max_exec_time,
                 rows::text AS row_count,
                 CASE WHEN shared_blks_hit + shared_blks_read > 0
                      THEN shared_blks_hit::float / (shared_blks_hit + shared_blks_read) END AS hit_ratio
          FROM pg_stat_statements
          ORDER BY mean_exec_time DESC
          LIMIT 50`)
        return {
          available: true,
          queries: rows.map((r) => ({
            query: r.query,
            calls: Number(r.calls),
            totalMs: r.total_exec_time,
            meanMs: r.mean_exec_time,
            maxMs: r.max_exec_time,
            rows: Number(r.row_count),
            hitRatio: r.hit_ratio,
          })),
        }
      } catch {
        // Extension present but view unreadable for this role/version.
        return { available: false, queries: [] }
      }
    })
  }
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d))
const isoOrNull = (d: Date | string | null): string | null => (d ? iso(d) : null)
