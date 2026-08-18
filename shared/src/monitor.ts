export interface SessionInfo {
  pid: number
  user: string | null
  database: string | null
  applicationName: string
  clientAddr: string | null
  state: string | null
  waitEventType: string | null
  waitEvent: string | null
  backendStart: string
  queryStart: string | null
  stateChange: string | null
  query: string
  /** Elapsed time of the current/last query in ms. */
  queryDurationMs: number | null
}

export interface LockInfo {
  pid: number
  lockType: string
  relation: string | null
  mode: string
  granted: boolean
  user: string | null
  query: string | null
  /** Pid this lock is waiting behind, when detectable. */
  blockedBy: number[]
}

export interface DbStats {
  sizeBytes: number
  cacheHitRatio: number | null
  commits: number
  rollbacks: number
  tupReturned: number
  tupFetched: number
  tupInserted: number
  tupUpdated: number
  tupDeleted: number
  deadlocks: number
  tempFiles: number
  tempBytes: number
  statsReset: string | null
  activeConnections: number
  maxConnections: number
  /** Cumulative block reads/hits — clients diff consecutive samples for rates. */
  blksRead: number
  blksHit: number
  /** Server-wide client-backend session states (snapshot). */
  sessionsTotal: number
  sessionsActive: number
  sessionsIdle: number
  sessionsIdleInTx: number
  locksTotal: number
  locksWaiting: number
}

export interface TableStat {
  schema: string
  name: string
  seqScans: number
  idxScans: number
  liveTuples: number
  deadTuples: number
  lastVacuum: string | null
  lastAutovacuum: string | null
  lastAnalyze: string | null
  totalBytes: number
}

export interface SlowQueryInfo {
  query: string
  calls: number
  totalMs: number
  meanMs: number
  maxMs: number
  rows: number
  hitRatio: number | null
}

export interface SlowQueriesResponse {
  /** False when pg_stat_statements is not installed on the server. */
  available: boolean
  queries: SlowQueryInfo[]
}
