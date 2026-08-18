import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  BackupInspection,
  BackupMode,
  BackupRecord,
  BackupRequest,
  MigrationRequest,
  RestoreRequest,
} from '@pgforge/shared'
import { BadRequestError, NotFoundError } from '../../core/errors.js'
import { quoteIdent } from '../../core/ident.js'
import { newId, nowIso } from '../../core/util.js'
import type { AppContext } from '../../context.js'
import type { ResolvedConnection } from '../../infra/pg.js'
import type { BackupRepo } from './backup.repo.js'

const FORMAT_FLAG = { custom: 'c', plain: 'p', tar: 't' } as const
const FORMAT_EXT = { custom: 'dump', plain: 'sql', tar: 'tar' } as const

const sanitize = (part: string) => part.replaceAll(/[^A-Za-z0-9._-]/g, '-')

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19)
}

function connArgs(conn: ResolvedConnection, database: string): string[] {
  return ['--host', conn.host, '--port', String(conn.port), '--username', conn.username, '--dbname', database]
}

function connEnv(conn: ResolvedConnection): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: conn.password,
    PGSSLMODE: conn.sslMode,
    PGCONNECT_TIMEOUT: '15',
  }
}

export class BackupService {
  /** Wired at the composition root; fires after a scheduled backup succeeds. */
  private autoDeliveryHook: ((backupId: string) => void) | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly repo: BackupRepo,
  ) {}

  setAutoDeliveryHook(hook: (backupId: string) => void): void {
    this.autoDeliveryHook = hook
  }

  list(connectionId?: string): BackupRecord[] {
    return this.repo.list(connectionId)
  }

  byId(id: string): BackupRecord {
    const record = this.repo.byId(id)
    if (!record) throw new NotFoundError('Backup not found')
    return record
  }

  filePath(record: BackupRecord): string {
    return path.join(this.ctx.config.backupDir, record.fileName)
  }

  async createBackup(
    req: BackupRequest,
    mode: BackupMode,
    scheduleId: string | null = null,
  ): Promise<BackupRecord> {
    if (req.schemaOnly && req.dataOnly) {
      throw new BadRequestError('schemaOnly and dataOnly are mutually exclusive')
    }
    const conn = this.ctx.resolveConnection(req.connectionId)
    await mkdir(this.ctx.config.backupDir, { recursive: true })

    const record: BackupRecord = {
      id: newId(),
      jobId: this.ctx.jobs.create('backup', req.connectionId, req.database),
      connectionId: req.connectionId,
      connectionName: null,
      database: req.database,
      format: req.format,
      mode,
      status: 'running',
      fileName: `${sanitize(req.database)}_${timestamp()}_${newId().slice(0, 8)}.${FORMAT_EXT[req.format]}`,
      sizeBytes: null,
      error: null,
      durationMs: null,
      scheduleId,
      createdAt: nowIso(),
    }
    this.repo.insert(record)

    const filePath = this.filePath(record)
    const args = [
      ...connArgs(conn, req.database),
      '--format',
      FORMAT_FLAG[req.format],
      '--file',
      filePath,
      '--verbose',
      '--no-password',
    ]
    for (const schema of req.schemas ?? []) args.push('--schema', schema)
    for (const table of req.tables ?? []) args.push('--table', table)
    if (req.schemaOnly) args.push('--schema-only')
    if (req.dataOnly) args.push('--data-only')

    const startedAt = Date.now()
    const proc = this.spawnTool(this.ctx.config.tools.pgDump, args, connEnv(conn), record.jobId)
    proc.on('close', (code) => {
      void (async () => {
        if (code === 0) {
          const size = await stat(filePath).then((s) => s.size).catch(() => null)
          this.ctx.jobs.finish(record.jobId, 'success')
          this.repo.markFinished(record.id, 'success', size, Date.now() - startedAt, null)
          if (scheduleId) {
            await this.pruneSchedule(scheduleId)
            this.autoDeliveryHook?.(record.id)
          }
        } else {
          const job = this.ctx.jobs.get(record.jobId)
          const error = code === null ? 'Canceled' : `pg_dump exited with code ${code}`
          this.ctx.jobs.finish(record.jobId, code === null ? 'canceled' : 'failed', error)
          this.repo.markFinished(
            record.id,
            code === null ? 'canceled' : 'failed',
            null,
            Date.now() - startedAt,
            lastLogLine(job?.log) ?? error,
          )
          await unlink(filePath).catch(() => {})
        }
      })()
    })
    return this.byId(record.id)
  }

  async restoreBackup(backupId: string, req: RestoreRequest): Promise<string> {
    const backup = this.byId(backupId)
    if (backup.status !== 'success') throw new BadRequestError('Backup is not restorable')
    const filePath = this.filePath(backup)
    await stat(filePath).catch(() => {
      throw new NotFoundError('Backup file is missing from disk')
    })
    return this.startRestore(filePath, backup.format === 'plain', req)
  }

  /** Restore from an uploaded .sql / .dump / .tar file. */
  async restoreUpload(
    fileName: string,
    content: Buffer,
    req: RestoreRequest,
  ): Promise<string> {
    const uploadsDir = path.join(this.ctx.config.backupDir, 'uploads')
    await mkdir(uploadsDir, { recursive: true })
    const safeName = `${timestamp()}_${sanitize(fileName)}`
    const filePath = path.join(uploadsDir, safeName)
    await writeFile(filePath, content)
    const isPlain = /\.sql$/i.test(fileName)
    return this.startRestore(filePath, isPlain, req)
  }

  private async startRestore(filePath: string, plain: boolean, req: RestoreRequest): Promise<string> {
    const conn = this.ctx.resolveConnection(req.connectionId)
    if (req.create) await this.createDatabaseIfRequested(req)
    const jobId = this.ctx.jobs.create('restore', req.connectionId, req.database)
    let proc: ChildProcess
    if (plain) {
      proc = this.spawnTool(
        this.ctx.config.tools.psql,
        [...connArgs(conn, req.database), '--no-password', '--set', 'ON_ERROR_STOP=1', '--file', filePath],
        connEnv(conn),
        jobId,
      )
    } else {
      const args = [...connArgs(conn, req.database), '--verbose', '--no-password']
      if (req.clean) args.push('--clean', '--if-exists')
      args.push(filePath)
      proc = this.spawnTool(this.ctx.config.tools.pgRestore, args, connEnv(conn), jobId)
    }
    proc.on('close', (code) => {
      if (code === 0) this.ctx.jobs.finish(jobId, 'success')
      else if (code === null) this.ctx.jobs.finish(jobId, 'canceled')
      else {
        const job = this.ctx.jobs.get(jobId)
        this.ctx.jobs.finish(jobId, 'failed', lastLogLine(job?.log) ?? `Restore exited with code ${code}`)
      }
    })
    return jobId
  }

  /** Stream pg_dump straight into pg_restore on another server. */
  async migrate(req: MigrationRequest): Promise<string> {
    const source = this.ctx.resolveConnection(req.sourceConnectionId)
    const target = this.ctx.resolveConnection(req.targetConnectionId)
    if (req.createDatabase) {
      await this.ctx.pools.withClient(req.targetConnectionId, undefined, (c) =>
        c.query(`CREATE DATABASE ${quoteIdent(req.targetDatabase)}`),
      )
    }
    const jobId = this.ctx.jobs.create('migration', req.sourceConnectionId, req.sourceDatabase)

    const dump = spawn(
      this.ctx.config.tools.pgDump,
      [...connArgs(source, req.sourceDatabase), '--format', 'c', '--verbose', '--no-password'],
      { env: connEnv(source), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const restore = spawn(
      this.ctx.config.tools.pgRestore,
      [...connArgs(target, req.targetDatabase), '--verbose', '--no-password'],
      { env: connEnv(target), stdio: ['pipe', 'ignore', 'pipe'] },
    )
    dump.stdout.pipe(restore.stdin)
    dump.stderr.on('data', (d: Buffer) => this.ctx.jobs.appendLog(jobId, `[dump] ${d.toString()}`))
    restore.stderr.on('data', (d: Buffer) => this.ctx.jobs.appendLog(jobId, `[restore] ${d.toString()}`))
    dump.on('error', (err) => this.ctx.jobs.finish(jobId, 'failed', `pg_dump: ${err.message}`))
    restore.on('error', (err) => this.ctx.jobs.finish(jobId, 'failed', `pg_restore: ${err.message}`))
    this.ctx.jobs.attachProcess(jobId, restore)
    this.armTimeout(restore, jobId, dump)

    dump.on('close', (code) => {
      if (code !== 0 && code !== null) {
        restore.kill('SIGTERM')
        this.ctx.jobs.finish(jobId, 'failed', `pg_dump exited with code ${code}`)
      }
    })
    restore.on('close', (code) => {
      if (code === 0) this.ctx.jobs.finish(jobId, 'success')
      else if (code === null) this.ctx.jobs.finish(jobId, 'canceled')
      else {
        const job = this.ctx.jobs.get(jobId)
        this.ctx.jobs.finish(jobId, 'failed', lastLogLine(job?.log) ?? `pg_restore exited with code ${code}`)
      }
    })
    return jobId
  }

  async deleteBackup(id: string): Promise<void> {
    const backup = this.byId(id)
    await this.closeInspection(id).catch(() => {})
    await unlink(this.filePath(backup)).catch(() => {})
    this.repo.delete(id)
  }

  // ── Inspection: restore into a disposable database for browsing/editing ──

  private inspectionDbName(backupId: string): string {
    return `pgforge_inspect_${backupId.replaceAll('-', '').slice(0, 12)}`
  }

  getInspection(backupId: string): BackupInspection {
    const record = this.repo.getInspection(backupId)
    if (!record) return { status: 'none', database: null, jobId: null, error: null }
    const job = this.ctx.jobs.get(record.jobId)
    const status =
      job?.status === 'success'
        ? 'ready'
        : job?.status === 'running' || job?.status === 'queued'
          ? 'preparing'
          : 'failed'
    return { status, database: record.database, jobId: record.jobId, error: job?.error ?? null }
  }

  async startInspection(backupId: string): Promise<BackupInspection> {
    const backup = this.byId(backupId)
    if (backup.status !== 'success') throw new BadRequestError('Backup is not restorable')

    const existing = this.getInspection(backupId)
    if (existing.status === 'preparing' || existing.status === 'ready') return existing
    if (existing.status === 'failed') {
      // Clean up the failed attempt and start over.
      await this.closeInspection(backupId).catch(() => {})
    }

    const database = this.inspectionDbName(backupId)
    await this.ctx.pools.withClient(backup.connectionId, undefined, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`)
      await c.query(`CREATE DATABASE ${quoteIdent(database)}`)
    })
    const jobId = await this.restoreBackup(backupId, {
      connectionId: backup.connectionId,
      database,
    })
    this.repo.insertInspection({
      backupId,
      connectionId: backup.connectionId,
      database,
      jobId,
      createdAt: nowIso(),
    })
    return { status: 'preparing', database, jobId, error: null }
  }

  async closeInspection(backupId: string): Promise<void> {
    const record = this.repo.getInspection(backupId)
    if (!record) return
    // End pooled connections to the scratch database before dropping it.
    await this.ctx.pools.invalidate(record.connectionId)
    await this.ctx.pools
      .withClient(record.connectionId, undefined, (c) =>
        c.query(`DROP DATABASE IF EXISTS ${quoteIdent(record.database)} WITH (FORCE)`),
      )
      .catch(() => {})
    this.repo.deleteInspection(backupId)
  }

  async pruneSchedule(scheduleId: string): Promise<void> {
    const schedule = this.repo.scheduleById(scheduleId)
    if (!schedule) return
    const backups = this.repo.successfulForSchedule(scheduleId)
    const excess = backups.length - schedule.retention
    for (let i = 0; i < excess; i++) {
      await this.deleteBackup(backups[i]!.id)
    }
    // Failed attempts have no files but their records must not pile up over
    // months of unattended scheduling — keep the newest few for diagnosis.
    const failed = this.repo.failedForSchedule(scheduleId)
    const excessFailed = failed.length - 10
    for (let i = 0; i < excessFailed; i++) {
      this.repo.delete(failed[i]!.id)
    }
  }

  private async createDatabaseIfRequested(req: RestoreRequest): Promise<void> {
    await this.ctx.pools
      .withClient(req.connectionId, undefined, (c) =>
        c.query(`CREATE DATABASE ${quoteIdent(req.database)}`),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : ''
        // Existing database is fine — restore proceeds into it.
        if (!/already exists/i.test(message)) throw err
      })
  }

  private spawnTool(
    tool: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    jobId: string,
  ): ChildProcess {
    const proc = spawn(tool, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.ctx.jobs.attachProcess(jobId, proc)
    proc.stdout?.on('data', (d: Buffer) => this.ctx.jobs.appendLog(jobId, d.toString()))
    proc.stderr?.on('data', (d: Buffer) => this.ctx.jobs.appendLog(jobId, d.toString()))
    proc.on('error', (err) => {
      this.ctx.jobs.finish(
        jobId,
        'failed',
        err.message.includes('ENOENT')
          ? `${tool} not found. Install PostgreSQL client tools or set the path in the environment.`
          : err.message,
      )
    })
    this.armTimeout(proc, jobId)
    return proc
  }

  /** A hung dump/restore must never survive forever — kill and mark failed. */
  private armTimeout(proc: ChildProcess, jobId: string, extra?: ChildProcess): void {
    const timeoutMs = this.ctx.config.backupTimeoutMs
    const killTimer = setTimeout(() => {
      this.ctx.jobs.finish(
        jobId,
        'failed',
        `Timed out after ${Math.round(timeoutMs / 60_000)} min — process killed`,
      )
      proc.kill('SIGKILL')
      extra?.kill('SIGKILL')
    }, timeoutMs)
    killTimer.unref()
    proc.on('close', () => clearTimeout(killTimer))
  }
}

function lastLogLine(log: string | undefined): string | null {
  if (!log) return null
  const lines = log.trim().split('\n')
  const errorLine = [...lines].reverse().find((l) => /error|fatal|failed/i.test(l))
  return errorLine ?? lines.at(-1) ?? null
}
