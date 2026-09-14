import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ClusterBackupContents,
  ClusterBackupRecord,
  ClusterBackupRequest,
  ClusterRestoreRequest,
} from '@pgforge/shared'
import { BadRequestError, NotFoundError } from '../../core/errors.js'
import { quoteIdent } from '../../core/ident.js'
import { extractEntry, listTar, packTar, readEntry, type TarEntry } from '../../core/tar.js'
import { newId, nowIso } from '../../core/util.js'
import type { AppContext } from '../../context.js'
import type { ResolvedConnection } from '../../infra/pg.js'
import type { ClusterBackupRepo } from './cluster.repo.js'

const MANIFEST = 'manifest.json'
const GLOBALS = 'globals.sql'
const DB_PREFIX = 'databases/'
/** ustar name field limit, minus room for the prefix and extension. */
const MAX_ENTRY_STEM = 80

const sanitize = (part: string) => part.replaceAll(/[^A-Za-z0-9._-]/g, '-')

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19)
}

function connArgs(conn: ResolvedConnection, database: string): string[] {
  return [
    '--host',
    conn.host,
    '--port',
    String(conn.port),
    '--username',
    conn.username,
    '--dbname',
    database,
  ]
}

function connEnv(conn: ResolvedConnection): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: conn.password,
    PGSSLMODE: conn.sslMode,
    PGCONNECT_TIMEOUT: '15',
  }
}

/**
 * Database names are far more permissive than archive entry names, and the
 * ustar header caps a path at 99 bytes. The manifest carries the authoritative
 * mapping, so an unrepresentable name falls back to its index rather than
 * failing the whole run.
 */
function entryNameFor(database: string, index: number): string {
  const stem = sanitize(database)
  const usable = stem.length > 0 && Buffer.byteLength(stem) <= MAX_ENTRY_STEM
  return `${DB_PREFIX}${usable ? stem : `db-${index}`}.dump`
}

interface ManifestFile {
  pgforgeVersion: string
  serverVersion: string | null
  createdAt: string
  includesGlobals: boolean
  databases: { name: string; entry: string; sizeBytes: number }[]
}

/**
 * Whole-server backup and restore, kept apart from the per-database service.
 *
 * PostgreSQL offers no single-file, restorable, all-databases dump: `pg_dump`
 * covers one database and `pg_dumpall` emits only plain SQL, which
 * `pg_restore` cannot read. This composes the two — a custom-format archive
 * per database plus one globals script — into a single tar, so the bundle is
 * one file and every database inside it still restores selectively.
 *
 * The per-database backup service, its schedules, inspection and delivery are
 * untouched by any of this.
 */
export class ClusterBackupService {
  constructor(
    private readonly ctx: AppContext,
    private readonly repo: ClusterBackupRepo,
  ) {}

  list(connectionId?: string): ClusterBackupRecord[] {
    return this.repo.list(connectionId)
  }

  byId(id: string): ClusterBackupRecord {
    const record = this.repo.byId(id)
    if (!record) throw new NotFoundError('Cluster backup not found')
    return record
  }

  filePath(record: ClusterBackupRecord): string {
    return path.join(this.ctx.config.backupDir, record.fileName)
  }

  /** Databases on the server this role can actually open. */
  async listDatabases(connectionId: string): Promise<string[]> {
    return this.ctx.pools.withClient(connectionId, undefined, async (client) => {
      const { rows } = await client.query<{ name: string }>(`
        SELECT datname AS name
        FROM pg_database
        WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
        ORDER BY datname`)
      return rows.map((r) => r.name)
    })
  }

  /**
   * Starts the run and returns immediately — the pipeline is several processes
   * in sequence, tracked through the job log like every other long task.
   */
  async createBackup(req: ClusterBackupRequest): Promise<ClusterBackupRecord> {
    const conn = this.ctx.resolveConnection(req.connectionId)
    const available = await this.listDatabases(req.connectionId)
    const selected =
      req.databases && req.databases.length > 0
        ? req.databases.filter((name) => available.includes(name))
        : available

    if (selected.length === 0) {
      throw new BadRequestError('No databases on this server are reachable for backup')
    }

    await mkdir(this.ctx.config.backupDir, { recursive: true })
    const jobId = this.ctx.jobs.create('cluster_backup', req.connectionId, `${selected.length} db`)

    const record: ClusterBackupRecord = {
      id: newId(),
      jobId,
      connectionId: req.connectionId,
      connectionName: null,
      status: 'running',
      fileName: `cluster_${sanitize(conn.host)}_${timestamp()}_${newId().slice(0, 8)}.tar`,
      sizeBytes: null,
      databases: selected,
      includesGlobals: req.includeGlobals !== false,
      error: null,
      durationMs: null,
      createdAt: nowIso(),
    }
    this.repo.insert(record)

    // Deliberately not awaited: the caller gets the record while work proceeds.
    void this.runBackup(record, conn, selected, req.includeGlobals !== false)
    return this.byId(record.id)
  }

  private async runBackup(
    record: ClusterBackupRecord,
    conn: ResolvedConnection,
    databases: string[],
    includeGlobals: boolean,
  ): Promise<void> {
    const startedAt = Date.now()
    const workDir = path.join(this.ctx.config.backupDir, '.tmp', record.id)
    const target = this.filePath(record)
    const members: { name: string; path: string }[] = []
    const captured: ManifestFile['databases'] = []
    let globalsCaptured = false

    try {
      await mkdir(path.join(workDir, 'databases'), { recursive: true })

      if (includeGlobals) {
        const globalsPath = path.join(workDir, GLOBALS)
        this.log(record.jobId, `> pg_dumpall --globals-only (${databases.length} databases follow)`)
        const code = await this.run(
          this.ctx.config.tools.pgDumpall,
          [
            '--host',
            conn.host,
            '--port',
            String(conn.port),
            '--username',
            conn.username,
            '--database',
            conn.defaultDatabase,
            '--globals-only',
            '--no-password',
            '--file',
            globalsPath,
          ],
          connEnv(conn),
          record.jobId,
        )
        if (code === 0) {
          members.push({ name: GLOBALS, path: globalsPath })
          globalsCaptured = true
        } else {
          // Roles usually need a superuser. Losing them is worth a warning, not
          // a failed backup — the per-database dumps are the valuable part.
          this.log(
            record.jobId,
            `! globals skipped (pg_dumpall exited ${code ?? 'null'}) — the bundle will hold databases only`,
          )
        }
      }

      for (const [index, database] of databases.entries()) {
        const entry = entryNameFor(database, index)
        const dumpPath = path.join(workDir, entry)
        this.log(record.jobId, `> pg_dump ${database} (${index + 1}/${databases.length})`)
        const code = await this.run(
          this.ctx.config.tools.pgDump,
          [
            ...connArgs(conn, database),
            '--format',
            'c',
            '--file',
            dumpPath,
            '--verbose',
            '--no-password',
          ],
          connEnv(conn),
          record.jobId,
        )
        if (code !== 0) {
          throw new Error(
            code === null
              ? 'Canceled'
              : `pg_dump failed for database "${database}" (exit ${code})`,
          )
        }
        const size = await stat(dumpPath).then((s) => s.size).catch(() => 0)
        members.push({ name: entry, path: dumpPath })
        captured.push({ name: database, entry, sizeBytes: size })
      }

      const manifestPath = path.join(workDir, MANIFEST)
      const manifest: ManifestFile = {
        pgforgeVersion: this.ctx.config.version,
        serverVersion: await this.serverVersion(record.connectionId),
        createdAt: record.createdAt,
        includesGlobals: globalsCaptured,
        databases: captured,
      }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
      // Manifest first, so a reader can learn the layout without scanning.
      members.unshift({ name: MANIFEST, path: manifestPath })

      this.log(record.jobId, `> packing ${members.length} entries into ${record.fileName}`)
      await packTar(target, members)
      const size = await stat(target).then((s) => s.size).catch(() => null)

      this.ctx.jobs.finish(record.jobId, 'success')
      this.repo.markFinished(
        record.id,
        'success',
        size,
        captured.map((d) => d.name),
        globalsCaptured,
        Date.now() - startedAt,
        null,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const canceled = message === 'Canceled'
      this.ctx.jobs.finish(record.jobId, canceled ? 'canceled' : 'failed', message)
      this.repo.markFinished(
        record.id,
        canceled ? 'canceled' : 'failed',
        null,
        captured.map((d) => d.name),
        globalsCaptured,
        Date.now() - startedAt,
        message,
      )
      await unlink(target).catch(() => {})
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Reads the bundle's manifest so the UI can offer its databases. */
  async contents(id: string): Promise<ClusterBackupContents> {
    const record = this.byId(id)
    const entries = await this.entriesOf(record)
    const manifestEntry = entries.find((e) => e.name === MANIFEST)
    if (!manifestEntry) {
      // A bundle without a manifest is still usable: fall back to the layout.
      return {
        appVersion: null,
        serverVersion: null,
        createdAt: record.createdAt,
        includesGlobals: entries.some((e) => e.name === GLOBALS),
        databases: entries
          .filter((e) => e.name.startsWith(DB_PREFIX))
          .map((e) => ({
            name: path.basename(e.name, '.dump'),
            entry: e.name,
            sizeBytes: e.size,
          })),
      }
    }
    const raw = await readEntry(this.filePath(record), manifestEntry)
    const manifest = JSON.parse(raw.toString('utf8')) as ManifestFile
    return {
      appVersion: manifest.pgforgeVersion ?? null,
      serverVersion: manifest.serverVersion ?? null,
      createdAt: manifest.createdAt ?? record.createdAt,
      includesGlobals: manifest.includesGlobals ?? false,
      databases: manifest.databases ?? [],
    }
  }

  /**
   * Restores selected databases (and optionally the globals) out of a bundle.
   * Returns the job id immediately; progress is in the job log.
   */
  async restore(id: string, req: ClusterRestoreRequest): Promise<string> {
    const record = this.byId(id)
    if (record.status !== 'success') throw new BadRequestError('Bundle is not restorable')
    const contents = await this.contents(id)

    const wanted =
      req.databases && req.databases.length > 0
        ? contents.databases.filter((d) => req.databases!.includes(d.name))
        : contents.databases
    if (wanted.length === 0 && !req.restoreGlobals) {
      throw new BadRequestError('Nothing selected to restore')
    }

    const conn = this.ctx.resolveConnection(req.connectionId)
    const jobId = this.ctx.jobs.create('cluster_restore', req.connectionId, `${wanted.length} db`)
    void this.runRestore(record, contents, wanted, req, conn, jobId)
    return jobId
  }

  private async runRestore(
    record: ClusterBackupRecord,
    contents: ClusterBackupContents,
    wanted: ClusterBackupContents['databases'],
    req: ClusterRestoreRequest,
    conn: ResolvedConnection,
    jobId: string,
  ): Promise<void> {
    const archive = this.filePath(record)
    const workDir = path.join(this.ctx.config.backupDir, '.tmp', `restore-${jobId}`)
    try {
      await stat(archive).catch(() => {
        throw new Error('Bundle file is missing from disk')
      })
      await mkdir(path.join(workDir, 'databases'), { recursive: true })
      const entries = await listTar(archive)
      const find = (name: string): TarEntry | undefined => entries.find((e) => e.name === name)

      if (req.restoreGlobals && contents.includesGlobals) {
        const entry = find(GLOBALS)
        if (entry) {
          const globalsPath = path.join(workDir, GLOBALS)
          await extractEntry(archive, entry, globalsPath)
          this.log(jobId, '> psql globals.sql (roles, tablespaces)')
          // Not ON_ERROR_STOP: re-applying globals to a server that already has
          // some of these roles is normal, and those errors are not failures.
          // Everything psql says still lands in the job log.
          const code = await this.run(
            this.ctx.config.tools.psql,
            [
              ...connArgs(conn, conn.defaultDatabase),
              '--no-password',
              '--set',
              'ON_ERROR_STOP=0',
              '--file',
              globalsPath,
            ],
            connEnv(conn),
            jobId,
          )
          if (code === null) throw new Error('Canceled')
          this.log(jobId, `< globals applied (psql exit ${code})`)
        }
      }

      for (const [index, database] of wanted.entries()) {
        const entry = find(database.entry)
        if (!entry) {
          this.log(jobId, `! ${database.name}: entry ${database.entry} missing from bundle`)
          continue
        }
        const dumpPath = path.join(workDir, database.entry)
        await extractEntry(archive, entry, dumpPath)

        if (req.createDatabases !== false) {
          await this.ctx.pools
            .withClient(req.connectionId, undefined, (c) =>
              c.query(`CREATE DATABASE ${quoteIdent(database.name)}`),
            )
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : ''
              if (!/already exists/i.test(message)) throw err
              this.log(jobId, `  ${database.name}: database exists, restoring into it`)
            })
        }

        this.log(jobId, `> pg_restore ${database.name} (${index + 1}/${wanted.length})`)
        const args = [...connArgs(conn, database.name), '--verbose', '--no-password']
        if (req.clean) args.push('--clean', '--if-exists')
        args.push(dumpPath)
        const code = await this.run(this.ctx.config.tools.pgRestore, args, connEnv(conn), jobId)
        if (code === null) throw new Error('Canceled')
        // pg_restore reports a non-zero exit for ignorable warnings too, so a
        // failure here is logged and the run continues to the next database.
        if (code !== 0) {
          this.log(jobId, `! ${database.name}: pg_restore exited ${code} — see the log above`)
        }
        await unlink(dumpPath).catch(() => {})
      }

      this.ctx.jobs.finish(jobId, 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.ctx.jobs.finish(jobId, message === 'Canceled' ? 'canceled' : 'failed', message)
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async deleteBackup(id: string): Promise<void> {
    const record = this.byId(id)
    await unlink(this.filePath(record)).catch(() => {})
    this.repo.delete(id)
  }

  private entriesOf(record: ClusterBackupRecord): Promise<TarEntry[]> {
    return listTar(this.filePath(record))
  }

  private async serverVersion(connectionId: string): Promise<string | null> {
    return this.ctx.pools
      .withClient(connectionId, undefined, async (c) => {
        const { rows } = await c.query<{ version: string }>('SELECT version() AS version')
        return rows[0]?.version ?? null
      })
      .catch(() => null)
  }

  private log(jobId: string, line: string): void {
    this.ctx.jobs.appendLog(jobId, `${line}\n`)
  }

  /**
   * Runs one tool to completion. Resolves with the exit code, or null when the
   * process was killed — which is how cancellation reaches the caller's loop.
   */
  private run(
    tool: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    jobId: string,
  ): Promise<number | null> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess
      try {
        proc = spawn(tool, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      // Re-attached per step, so cancelling the job kills whatever runs now.
      this.ctx.jobs.attachProcess(jobId, proc)
      proc.stdout?.on('data', (d: Buffer) => this.ctx.jobs.appendLog(jobId, d.toString()))
      proc.stderr?.on('data', (d: Buffer) => this.ctx.jobs.appendLog(jobId, d.toString()))

      const timeoutMs = this.ctx.config.backupTimeoutMs
      const killTimer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
      killTimer.unref()

      proc.on('error', (err) => {
        clearTimeout(killTimer)
        reject(
          new Error(
            err.message.includes('ENOENT')
              ? `${tool} not found. Install the PostgreSQL client tools or set its path in the environment.`
              : err.message,
          ),
        )
      })
      proc.on('close', (code) => {
        clearTimeout(killTimer)
        resolve(code)
      })
    })
  }
}
