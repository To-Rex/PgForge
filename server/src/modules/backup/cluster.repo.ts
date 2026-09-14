import type { ClusterBackupRecord, JobStatus } from '@pgforge/shared'
import type { MetaStore } from '../../infra/store.js'

interface Row {
  id: string
  job_id: string
  connection_id: string
  status: JobStatus
  file_name: string
  size_bytes: number | null
  databases: string
  includes_globals: number
  error: string | null
  duration_ms: number | null
  created_at: string
  connection_name: string | null
}

const SELECT = `
  SELECT b.*, c.name AS connection_name
  FROM cluster_backups b LEFT JOIN connections c ON c.id = b.connection_id`

/** The column is JSON text; a corrupt value must not take the whole list down. */
function parseDatabases(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

const toRecord = (r: Row): ClusterBackupRecord => ({
  id: r.id,
  jobId: r.job_id,
  connectionId: r.connection_id,
  connectionName: r.connection_name,
  status: r.status,
  fileName: r.file_name,
  sizeBytes: r.size_bytes,
  databases: parseDatabases(r.databases),
  includesGlobals: r.includes_globals === 1,
  error: r.error,
  durationMs: r.duration_ms,
  createdAt: r.created_at,
})

export class ClusterBackupRepo {
  constructor(private readonly store: MetaStore) {}

  list(connectionId?: string): ClusterBackupRecord[] {
    const rows = connectionId
      ? this.store.all<Row>(
          `${SELECT} WHERE b.connection_id = :connectionId ORDER BY b.created_at DESC`,
          { connectionId },
        )
      : this.store.all<Row>(`${SELECT} ORDER BY b.created_at DESC`)
    return rows.map(toRecord)
  }

  byId(id: string): ClusterBackupRecord | undefined {
    const row = this.store.get<Row>(`${SELECT} WHERE b.id = :id`, { id })
    return row ? toRecord(row) : undefined
  }

  insert(record: ClusterBackupRecord): void {
    this.store.run(
      `INSERT INTO cluster_backups
         (id, job_id, connection_id, status, file_name, size_bytes, databases,
          includes_globals, error, duration_ms, created_at)
       VALUES
         (:id, :jobId, :connectionId, :status, :fileName, :sizeBytes, :databases,
          :includesGlobals, :error, :durationMs, :createdAt)`,
      {
        id: record.id,
        jobId: record.jobId,
        connectionId: record.connectionId,
        status: record.status,
        fileName: record.fileName,
        sizeBytes: record.sizeBytes,
        databases: JSON.stringify(record.databases),
        includesGlobals: record.includesGlobals ? 1 : 0,
        error: record.error,
        durationMs: record.durationMs,
        createdAt: record.createdAt,
      },
    )
  }

  markFinished(
    id: string,
    status: JobStatus,
    sizeBytes: number | null,
    databases: string[],
    includesGlobals: boolean,
    durationMs: number,
    error: string | null,
  ): void {
    this.store.run(
      `UPDATE cluster_backups
       SET status = :status, size_bytes = :sizeBytes, databases = :databases,
           includes_globals = :includesGlobals, duration_ms = :durationMs, error = :error
       WHERE id = :id`,
      {
        id,
        status,
        sizeBytes,
        databases: JSON.stringify(databases),
        includesGlobals: includesGlobals ? 1 : 0,
        durationMs: Math.round(durationMs),
        error,
      },
    )
  }

  delete(id: string): void {
    this.store.run('DELETE FROM cluster_backups WHERE id = :id', { id })
  }
}
