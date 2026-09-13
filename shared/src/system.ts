import type { SslMode } from './connections.js'

/**
 * Connection details for the metadata database, entered field by field.
 * The server assembles the DSN from these, so escaping a password full of
 * punctuation is never the operator's problem.
 */
export interface MetadataConnectionInput {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: SslMode
}

/** Everything except the password — safe to return from the API. */
export type MetadataConnectionParts = Omit<MetadataConnectionInput, 'password'>

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
  /** Current settings split into fields, so the form can prefill itself. */
  connection: MetadataConnectionParts | null
  snapshot: MetadataSnapshotInfo | null
  lastSyncedAt: string | null
  /** Last replication failure, if the most recent flush did not succeed. */
  lastError: string | null
  /** Size of the local SQLite image backing the running process. */
  localBytes: number
  /**
   * Every .env the server could load. A save writes the setting to all of
   * them, so whichever one startup picks holds the same value.
   */
  envPaths: string[]
  /** The one startup will actually read — the first that exists. */
  envPathLoaded: string | null
  /** True when at least one of `envPaths` can be written. */
  envWritable: boolean
  /** True when .env holds a different value than the running process uses. */
  restartRequired: boolean
  /** Backup artifacts still live on disk — the snapshot covers metadata only. */
  backupDir: string
  /**
   * The snapshot holds encrypted connection passwords, never the key that
   * opens them. An auto-generated secret lives in DATA_DIR, so a redeploy that
   * wipes DATA_DIR restores every connection unusable.
   */
  secret: {
    source: 'env' | 'file'
    /** Where the generated secret is persisted; null when APP_SECRET is set. */
    file: string | null
    /** True when a PostgreSQL store is configured but the secret is not pinned. */
    atRisk: boolean
  }
}

export interface AppSecretRevealResult {
  /** The live master secret, so it can be pinned in the platform environment. */
  secret: string
  envLine: string
}

export interface MetadataTestRequest {
  /** Preferred form: the server builds the DSN from these fields. */
  connection?: MetadataConnectionInput
  /** Still accepted for scripted setups that already hold a DSN. */
  url?: string
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
  /** Exactly what would be saved, with the password masked. */
  maskedUrl: string | null
  error: string | null
}

export interface MetadataSaveResult {
  ok: boolean
  /** The exact line written; also what to paste into a platform env editor. */
  envLine: string
  /** Files actually written; empty when none were writable. */
  envPaths: string[]
  envWritten: boolean
  /** Always true: the store is wired once at boot. */
  restartRequired: boolean
  /** Rows uploaded from the current SQLite image as the initial snapshot. */
  seededBytes: number | null
}
