import type { JobStatus } from './jobs.js'

/**
 * A whole-server backup: every database as its own `pg_dump --format=custom`
 * archive, plus the cluster-wide objects `pg_dump` cannot see (roles,
 * passwords, tablespaces), bundled into one tar file.
 *
 * PostgreSQL has no single-file equivalent — `pg_dump` covers one database and
 * `pg_dumpall` only emits plain SQL — so the bundle is what makes "one file"
 * and "restorable with pg_restore" true at the same time.
 */
export interface ClusterBackupRecord {
  id: string
  jobId: string
  connectionId: string
  connectionName: string | null
  status: JobStatus
  fileName: string
  sizeBytes: number | null
  /** Databases captured, in the order they were dumped. */
  databases: string[]
  /** False when the role lacked the rights to read cluster-wide objects. */
  includesGlobals: boolean
  error: string | null
  durationMs: number | null
  createdAt: string
}

export interface ClusterBackupRequest {
  connectionId: string
  /** Empty/omitted = every database the role can connect to. */
  databases?: string[]
  /** Include roles, passwords and tablespaces. Default true. */
  includeGlobals?: boolean
}

/** What a stored bundle actually contains, read back from its manifest. */
export interface ClusterBackupContents {
  /** PgForge version that wrote the bundle. */
  appVersion: string | null
  serverVersion: string | null
  createdAt: string | null
  includesGlobals: boolean
  databases: { name: string; entry: string; sizeBytes: number }[]
}

export interface ClusterRestoreRequest {
  /** Server to restore into — may differ from the one backed up. */
  connectionId: string
  /** Empty/omitted = every database in the bundle. */
  databases?: string[]
  /** Apply roles/tablespaces first. Needs a superuser-ish role. */
  restoreGlobals?: boolean
  /** Create each target database when missing. */
  createDatabases?: boolean
  /** Drop objects before recreating them, per database. */
  clean?: boolean
}
