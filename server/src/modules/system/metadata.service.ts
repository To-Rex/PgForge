import type {
  MetadataConnectionInput,
  MetadataSaveResult,
  MetadataStatus,
  MetadataTestResult,
} from '@pgforge/shared'
import { buildMetadataDsn, parseMetadataDsn } from '../../core/dsn.js'
import { BadRequestError } from '../../core/errors.js'
import {
  envLine,
  isEnvWritable,
  maskDatabaseUrl,
  readEnvVar,
  removeEnvVar,
  resolveEnvFile,
  resolveEnvFiles,
  upsertEnvVar,
} from '../../core/env-file.js'
import { PostgresMetadataBackend } from '../../infra/metadata-pg.js'
import type { MetadataSync } from '../../infra/metadata-sync.js'
import type { AppContext } from '../../context.js'

const ENV_KEY = 'METADATA_URL'

/**
 * Reads and changes where PgForge keeps its own data.
 *
 * Changing it only takes effect on restart — the store is opened once at boot
 * and every repository holds it — so a save writes the setting and says so
 * plainly rather than pretending to switch live.
 */
export class MetadataService {
  constructor(
    private readonly ctx: AppContext,
    private readonly sync: MetadataSync | null,
  ) {}

  /** The file the next boot will read — what `restartRequired` compares against. */
  private loadedEnvFile(): string {
    return resolveEnvFile()
  }

  /** Every file a save should keep in step. */
  private envFiles(): string[] {
    return resolveEnvFiles()
  }

  /**
   * Applies a change to every `.env` the server could load. Startup reads only
   * the first that exists, so leaving the others behind would let a stale value
   * resurface the moment that file is added or removed.
   */
  private writeAll(apply: (file: string) => void): string[] {
    const written: string[] = []
    for (const file of this.envFiles()) {
      if (!isEnvWritable(file)) continue
      apply(file)
      written.push(file)
    }
    return written
  }

  /**
   * The UI sends fields; scripted callers may still send a DSN. Building it
   * here keeps percent-encoding in exactly one place.
   */
  private resolve(request: { connection?: MetadataConnectionInput; url?: string }): string {
    if (request.connection) return buildMetadataDsn(request.connection)
    const url = request.url?.trim()
    if (!url) throw new BadRequestError('Provide connection details for the metadata database')
    return url
  }

  status(): MetadataStatus {
    const envPaths = this.envFiles()
    const loaded = this.loadedEnvFile()
    const fromFile = readEnvVar(loaded, ENV_KEY)
    const active = this.ctx.config.metadataUrl
    const syncStatus = this.sync?.status

    return {
      mode: active ? 'postgres' : 'sqlite',
      source: active === null ? 'default' : fromFile === active ? 'env-file' : 'env',
      maskedUrl: active ? maskDatabaseUrl(active) : null,
      connection: active ? parseMetadataDsn(active) : null,
      snapshot: syncStatus?.snapshot ?? null,
      lastSyncedAt: syncStatus?.lastSyncedAt ?? null,
      lastError: syncStatus?.lastError ?? null,
      localBytes: this.ctx.store.byteSize(),
      envPaths,
      envPathLoaded: loaded,
      envWritable: envPaths.some(isEnvWritable),
      // Normalise both sides: absent and empty mean the same thing here.
      restartRequired: (fromFile ?? null) !== (active ?? null),
      backupDir: this.ctx.config.backupDir,
    }
  }

  async test(
    request: { connection?: MetadataConnectionInput; url?: string },
    createDatabase: boolean,
  ): Promise<MetadataTestResult> {
    const url = this.resolve(request)
    const result = await PostgresMetadataBackend.test(url, createDatabase)
    // Show exactly what would be saved, so a mistyped field is visible before
    // it is committed — never the password itself.
    return { ...result, maskedUrl: maskDatabaseUrl(url) }
  }

  /**
   * Verifies the target, seeds it from the running store when it is still
   * empty, and records the setting. Seeding is what makes the switch lossless:
   * the users and connections you have right now become the first snapshot.
   *
   * A target that already holds a snapshot is left untouched — it belongs to
   * another deployment, and overwriting it from here would be destructive.
   */
  async save(
    request: { connection?: MetadataConnectionInput; url?: string },
    createDatabase: boolean,
  ): Promise<MetadataSaveResult> {
    const trimmed = this.resolve(request)
    const result = await PostgresMetadataBackend.test(trimmed, createDatabase)
    if (!result.ok) {
      throw new BadRequestError(result.error ?? 'Could not connect to the metadata database')
    }

    let seededBytes: number | null = null
    if (!result.snapshot) {
      const backend = new PostgresMetadataBackend(trimmed)
      await backend.init()
      const bytes = this.ctx.store.snapshot()
      await backend.save(bytes, this.ctx.config.version)
      seededBytes = bytes.length
    }

    const written = this.writeAll((file) => upsertEnvVar(file, ENV_KEY, trimmed))

    return {
      ok: true,
      envLine: envLine(ENV_KEY, trimmed),
      envPaths: written,
      envWritten: written.length > 0,
      restartRequired: true,
      seededBytes,
    }
  }

  /** Reverts to the SQLite-only default by dropping the setting from .env. */
  disable(): MetadataSaveResult {
    const written = this.writeAll((file) => removeEnvVar(file, ENV_KEY))
    return {
      ok: true,
      envLine: `# ${ENV_KEY}=`,
      envPaths: written,
      envWritten: written.length > 0,
      restartRequired: true,
      seededBytes: null,
    }
  }

  /** Forces an immediate upload; surfaces replication problems on demand. */
  async flush(): Promise<MetadataStatus> {
    if (!this.sync) throw new BadRequestError('No metadata database is configured')
    await this.sync.flush(true)
    return this.status()
  }
}
