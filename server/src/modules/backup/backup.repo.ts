import type { BackupFormat, BackupMode, BackupRecord, BackupSchedule, JobStatus } from '@pgforge/shared'
import type { MetaStore } from '../../infra/store.js'

interface BackupRow {
  id: string
  job_id: string
  connection_id: string
  database: string
  format: BackupFormat
  mode: BackupMode
  status: JobStatus
  file_name: string
  size_bytes: number | null
  error: string | null
  duration_ms: number | null
  schedule_id: string | null
  created_at: string
  connection_name: string | null
}

interface ScheduleRow {
  id: string
  name: string
  connection_id: string
  database: string
  cron: string
  format: BackupFormat
  retention: number
  enabled: number
  last_run_at: string | null
  created_at: string
  connection_name: string | null
}

const SELECT_BACKUP = `
  SELECT b.*, c.name AS connection_name
  FROM backups b LEFT JOIN connections c ON c.id = b.connection_id`

const SELECT_SCHEDULE = `
  SELECT s.*, c.name AS connection_name
  FROM backup_schedules s LEFT JOIN connections c ON c.id = s.connection_id`

const toBackup = (r: BackupRow): BackupRecord => ({
  id: r.id,
  jobId: r.job_id,
  connectionId: r.connection_id,
  connectionName: r.connection_name,
  database: r.database,
  format: r.format,
  mode: r.mode,
  status: r.status,
  fileName: r.file_name,
  sizeBytes: r.size_bytes,
  error: r.error,
  durationMs: r.duration_ms,
  scheduleId: r.schedule_id,
  createdAt: r.created_at,
})

const toSchedule = (r: ScheduleRow): BackupSchedule => ({
  id: r.id,
  name: r.name,
  connectionId: r.connection_id,
  connectionName: r.connection_name,
  database: r.database,
  cron: r.cron,
  format: r.format,
  retention: r.retention,
  enabled: r.enabled === 1,
  lastRunAt: r.last_run_at,
  nextRunAt: null, // filled by the scheduler, which owns cron parsing
  createdAt: r.created_at,
})

export class BackupRepo {
  constructor(private readonly store: MetaStore) {}

  list(connectionId?: string): BackupRecord[] {
    const rows = connectionId
      ? this.store.all<BackupRow>(
          `${SELECT_BACKUP} WHERE b.connection_id = :connectionId ORDER BY b.created_at DESC`,
          { connectionId },
        )
      : this.store.all<BackupRow>(`${SELECT_BACKUP} ORDER BY b.created_at DESC`)
    return rows.map(toBackup)
  }

  byId(id: string): BackupRecord | undefined {
    const row = this.store.get<BackupRow>(`${SELECT_BACKUP} WHERE b.id = :id`, { id })
    return row ? toBackup(row) : undefined
  }

  insert(record: BackupRecord): void {
    this.store.run(
      `INSERT INTO backups (id, job_id, connection_id, database, format, mode, status, file_name, schedule_id, created_at)
       VALUES (:id, :jobId, :connectionId, :database, :format, :mode, :status, :fileName, :scheduleId, :createdAt)`,
      {
        id: record.id,
        jobId: record.jobId,
        connectionId: record.connectionId,
        database: record.database,
        format: record.format,
        mode: record.mode,
        status: record.status,
        fileName: record.fileName,
        scheduleId: record.scheduleId,
        createdAt: record.createdAt,
      },
    )
  }

  markFinished(id: string, status: JobStatus, sizeBytes: number | null, durationMs: number, error: string | null): void {
    this.store.run(
      `UPDATE backups SET status = :status, size_bytes = :sizeBytes, duration_ms = :durationMs, error = :error
       WHERE id = :id`,
      { id, status, sizeBytes, durationMs: Math.round(durationMs), error },
    )
  }

  delete(id: string): void {
    this.store.run('DELETE FROM backups WHERE id = :id', { id })
  }

  /** Successful backups for a schedule, oldest first — used for retention pruning. */
  successfulForSchedule(scheduleId: string): BackupRecord[] {
    return this.store
      .all<BackupRow>(
        `${SELECT_BACKUP} WHERE b.schedule_id = :scheduleId AND b.status = 'success' ORDER BY b.created_at ASC`,
        { scheduleId },
      )
      .map(toBackup)
  }

  listSchedules(): BackupSchedule[] {
    return this.store.all<ScheduleRow>(`${SELECT_SCHEDULE} ORDER BY s.name`).map(toSchedule)
  }

  scheduleById(id: string): BackupSchedule | undefined {
    const row = this.store.get<ScheduleRow>(`${SELECT_SCHEDULE} WHERE s.id = :id`, { id })
    return row ? toSchedule(row) : undefined
  }

  insertSchedule(s: BackupSchedule): void {
    this.store.run(
      `INSERT INTO backup_schedules (id, name, connection_id, database, cron, format, retention, enabled, created_at)
       VALUES (:id, :name, :connectionId, :database, :cron, :format, :retention, :enabled, :createdAt)`,
      {
        id: s.id,
        name: s.name,
        connectionId: s.connectionId,
        database: s.database,
        cron: s.cron,
        format: s.format,
        retention: s.retention,
        enabled: s.enabled ? 1 : 0,
        createdAt: s.createdAt,
      },
    )
  }

  updateSchedule(s: BackupSchedule): void {
    this.store.run(
      `UPDATE backup_schedules SET name = :name, connection_id = :connectionId, database = :database,
        cron = :cron, format = :format, retention = :retention, enabled = :enabled
       WHERE id = :id`,
      {
        id: s.id,
        name: s.name,
        connectionId: s.connectionId,
        database: s.database,
        cron: s.cron,
        format: s.format,
        retention: s.retention,
        enabled: s.enabled ? 1 : 0,
      },
    )
  }

  touchScheduleRun(id: string, at: string): void {
    this.store.run('UPDATE backup_schedules SET last_run_at = :at WHERE id = :id', { id, at })
  }

  deleteSchedule(id: string): boolean {
    return this.store.run('DELETE FROM backup_schedules WHERE id = :id', { id }).changes > 0
  }

  getInspection(backupId: string): InspectionRecord | undefined {
    const row = this.store.get<{
      backup_id: string
      connection_id: string
      database: string
      job_id: string
      created_at: string
    }>('SELECT * FROM backup_inspections WHERE backup_id = :backupId', { backupId })
    if (!row) return undefined
    return {
      backupId: row.backup_id,
      connectionId: row.connection_id,
      database: row.database,
      jobId: row.job_id,
      createdAt: row.created_at,
    }
  }

  insertInspection(record: InspectionRecord): void {
    this.store.run(
      `INSERT INTO backup_inspections (backup_id, connection_id, database, job_id, created_at)
       VALUES (:backupId, :connectionId, :database, :jobId, :createdAt)`,
      record as unknown as Record<string, string>,
    )
  }

  deleteInspection(backupId: string): void {
    this.store.run('DELETE FROM backup_inspections WHERE backup_id = :backupId', { backupId })
  }
}

export interface InspectionRecord {
  backupId: string
  connectionId: string
  database: string
  jobId: string
  createdAt: string
}
