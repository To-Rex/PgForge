export type JobType = 'backup' | 'restore' | 'migration' | 'delivery'
export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled'

export interface JobInfo {
  id: string
  type: JobType
  status: JobStatus
  connectionId: string
  database: string
  /** Tail of the tool's output, newest last. */
  log: string
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export type BackupFormat = 'custom' | 'plain' | 'tar'
export type BackupMode = 'manual' | 'scheduled'

export interface BackupRecord {
  id: string
  jobId: string
  connectionId: string
  connectionName: string | null
  database: string
  format: BackupFormat
  mode: BackupMode
  status: JobStatus
  fileName: string
  sizeBytes: number | null
  error: string | null
  durationMs: number | null
  scheduleId: string | null
  createdAt: string
}

export interface BackupRequest {
  connectionId: string
  database: string
  format: BackupFormat
  /** Empty/omitted = whole database. */
  schemas?: string[]
  /** Fully-qualified `schema.table` names. */
  tables?: string[]
  schemaOnly?: boolean
  dataOnly?: boolean
}

export interface RestoreRequest {
  connectionId: string
  database: string
  /** Drop objects before recreating them. */
  clean?: boolean
  /** Create the target database first (restores into it). */
  create?: boolean
}

export interface MigrationRequest {
  sourceConnectionId: string
  sourceDatabase: string
  targetConnectionId: string
  targetDatabase: string
  /** Create the target database before piping the dump. */
  createDatabase?: boolean
}

export interface BackupSchedule {
  id: string
  name: string
  connectionId: string
  connectionName: string | null
  database: string
  /** Standard 5-field cron expression. */
  cron: string
  format: BackupFormat
  /** Number of backups retained; older ones are pruned after each run. */
  retention: number
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
}

export interface BackupScheduleInput {
  name: string
  connectionId: string
  database: string
  cron: string
  format: BackupFormat
  retention: number
  enabled: boolean
}

export interface CronPreview {
  valid: boolean
  /** Next few fire times (ISO), empty when the expression is invalid. */
  nextRuns: string[]
}

/**
 * Browsing a backup = restoring it into a disposable database on the same
 * server and pointing the regular explorer at it.
 */
export interface BackupInspection {
  status: 'none' | 'preparing' | 'ready' | 'failed'
  database: string | null
  jobId: string | null
  error: string | null
}
