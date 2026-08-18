import type { ChildProcess } from 'node:child_process'
import type { JobInfo, JobStatus, JobType } from '@pgforge/shared'
import { newId, nowIso } from '../core/util.js'
import type { MetaStore } from './store.js'

const LOG_CAP_LINES = 800

interface LiveJob {
  id: string
  type: JobType
  status: JobStatus
  connectionId: string
  database: string
  logLines: string[]
  proc: ChildProcess | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

interface JobRow {
  id: string
  type: JobType
  status: JobStatus
  connection_id: string
  database: string
  log: string
  error: string | null
  started_at: string
  finished_at: string | null
}

/**
 * Tracks long-running external processes (pg_dump / pg_restore pipelines).
 * Live state is in memory for fast polling; terminal state is persisted.
 */
export class JobManager {
  private readonly live = new Map<string, LiveJob>()

  constructor(private readonly store: MetaStore) {
    // Jobs left 'running' by a previous process can never finish.
    this.store.run(
      `UPDATE jobs SET status = 'failed', error = 'Interrupted by server restart', finished_at = :now
       WHERE status IN ('queued','running')`,
      { now: nowIso() },
    )
  }

  create(type: JobType, connectionId: string, database: string): string {
    const id = newId()
    const startedAt = nowIso()
    this.store.run(
      `INSERT INTO jobs (id, type, status, connection_id, database, started_at)
       VALUES (:id, :type, 'running', :connectionId, :database, :startedAt)`,
      { id, type, connectionId, database, startedAt },
    )
    this.live.set(id, {
      id,
      type,
      status: 'running',
      connectionId,
      database,
      logLines: [],
      proc: null,
      error: null,
      startedAt,
      finishedAt: null,
    })
    return id
  }

  attachProcess(id: string, proc: ChildProcess): void {
    const job = this.live.get(id)
    if (job) job.proc = proc
  }

  appendLog(id: string, chunk: string): void {
    const job = this.live.get(id)
    if (!job) return
    for (const line of chunk.split('\n')) {
      const trimmed = line.trimEnd()
      if (trimmed) job.logLines.push(trimmed)
    }
    if (job.logLines.length > LOG_CAP_LINES) {
      job.logLines.splice(0, job.logLines.length - LOG_CAP_LINES)
    }
  }

  finish(id: string, status: Exclude<JobStatus, 'queued' | 'running'>, error?: string): void {
    const job = this.live.get(id)
    if (!job || job.status !== 'running') return
    job.status = status
    job.error = error ?? null
    job.finishedAt = nowIso()
    job.proc = null
    this.store.run(
      `UPDATE jobs SET status = :status, error = :error, log = :log, finished_at = :finishedAt
       WHERE id = :id`,
      {
        id,
        status,
        error: job.error,
        log: job.logLines.join('\n'),
        finishedAt: job.finishedAt,
      },
    )
    // Long-run hygiene: release the in-memory entry once pollers had time to
    // read it — get() falls back to the persisted row afterwards. Without
    // this, months of scheduled backups would accumulate logs in memory.
    const release = setTimeout(() => this.live.delete(id), 10 * 60_000)
    release.unref()
  }

  cancel(id: string): boolean {
    const job = this.live.get(id)
    if (!job || job.status !== 'running') return false
    job.proc?.kill('SIGTERM')
    this.finish(id, 'canceled')
    return true
  }

  get(id: string): JobInfo | undefined {
    const job = this.live.get(id)
    if (job) {
      return {
        id: job.id,
        type: job.type,
        status: job.status,
        connectionId: job.connectionId,
        database: job.database,
        log: job.logLines.join('\n'),
        error: job.error,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      }
    }
    const row = this.store.get<JobRow>('SELECT * FROM jobs WHERE id = :id', { id })
    if (!row) return undefined
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      connectionId: row.connection_id,
      database: row.database,
      log: row.log,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }
  }

  /** Kill everything on shutdown so no orphan dumps keep running. */
  shutdown(): void {
    for (const job of this.live.values()) {
      if (job.status === 'running') {
        job.proc?.kill('SIGTERM')
        this.finish(job.id, 'canceled', 'Server shutdown')
      }
    }
  }
}
