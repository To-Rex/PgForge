/**
 * Where PgForge keeps its own data (users, connections, history, audit …).
 *
 * `sqlite` is the default: a file under DATA_DIR. `postgres` keeps that same
 * SQLite image in a PostgreSQL table, so the platform survives a redeploy that
 * wipes the container filesystem.
 */
export type MetadataMode = 'sqlite' | 'postgres'

/** How the active setting reached the process. */
export type MetadataSource = 'env' | 'env-file' | 'default'

export interface MetadataSnapshotInfo {
  byteSize: number
  revision: number
  updatedAt: string
  appVersion: string | null
}

export interface MetadataStatus {
  /** What the running process is actually using right now. */
  mode: MetadataMode
  source: MetadataSource
  /** Password replaced with `***`; the raw DSN is never returned. */
  maskedUrl: string | null
  snapshot: MetadataSnapshotInfo | null
  lastSyncedAt: string | null
  /** Last replication failure, if the most recent flush did not succeed. */
  lastError: string | null
  /** Size of the local SQLite image backing the running process. */
  localBytes: number
  /** Absolute path of the .env file the server would write to, if any. */
  envPath: string | null
  envWritable: boolean
  /** True when .env holds a different value than the running process uses. */
  restartRequired: boolean
  /** Backup artifacts still live on disk — the snapshot covers metadata only. */
  backupDir: string
}

export interface MetadataTestRequest {
  url: string
  /** Attempt `CREATE DATABASE` when the target database does not exist. */
  createDatabase?: boolean
}

export interface MetadataTestResult {
  ok: boolean
  serverVersion: string | null
  database: string | null
  /** True when the connection could create (or already had) the pgforge schema. */
  schemaReady: boolean
  /** A snapshot already present in that database — switching would adopt it. */
  snapshot: MetadataSnapshotInfo | null
  /** Set when the database was created by this call. */
  databaseCreated: boolean
  error: string | null
}

export interface MetadataSaveResult {
  ok: boolean
  /** The exact line written; also what to paste into a platform env editor. */
  envLine: string
  envPath: string | null
  envWritten: boolean
  /** Always true: the store is wired once at boot. */
  restartRequired: boolean
  /** Rows uploaded from the current SQLite image as the initial snapshot. */
  seededBytes: number | null
}
