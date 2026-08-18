import pg from 'pg'
import type {
  ConnectionInput,
  ConnectionSummary,
  ConnectionTestResult,
  ServerOverview,
} from '@pgforge/shared'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors.js'
import { encryptSecret } from '../../core/crypto.js'
import { newId, nowIso } from '../../core/util.js'
import type { AppContext } from '../../context.js'
import { resolveRecord } from '../../context.js'
import { toSummary, type ConnectionRecord } from './connections.repo.js'

const TEST_TIMEOUT_MS = 6_000

export class ConnectionsService {
  constructor(private readonly ctx: AppContext) {}

  list(): ConnectionSummary[] {
    return this.ctx.connections.list().map(toSummary)
  }

  get(id: string): ConnectionSummary {
    const record = this.requireRecord(id)
    return toSummary(record)
  }

  create(input: ConnectionInput): ConnectionSummary {
    if (!input.password) throw new BadRequestError('Password is required for new connections')
    const now = nowIso()
    const record: ConnectionRecord = {
      id: newId(),
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      passwordEnc: encryptSecret(input.password, this.ctx.config.credentialKey),
      defaultDatabase: input.defaultDatabase,
      sslMode: input.sslMode,
      color: input.color ?? null,
      readOnly: input.readOnly ?? false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    }
    this.ctx.connections.insert(record)
    return toSummary(record)
  }

  async update(id: string, input: ConnectionInput): Promise<ConnectionSummary> {
    const record = this.requireRecord(id)
    record.name = input.name
    record.host = input.host
    record.port = input.port
    record.username = input.username
    record.defaultDatabase = input.defaultDatabase
    record.sslMode = input.sslMode
    record.color = input.color ?? null
    record.readOnly = input.readOnly ?? false
    if (input.password) {
      record.passwordEnc = encryptSecret(input.password, this.ctx.config.credentialKey)
    }
    this.ctx.connections.update(record)
    await this.ctx.pools.invalidate(id)
    return toSummary(record)
  }

  async delete(id: string): Promise<void> {
    this.requireRecord(id)
    await this.ctx.pools.invalidate(id)
    this.ctx.connections.delete(id)
    // Orphaned schedules must not fire against a deleted connection.
    this.ctx.store.run('DELETE FROM backup_schedules WHERE connection_id = :id', { id })
  }

  /** Tests either stored credentials (id) or unsaved form input. */
  async test(input: { id?: string; config?: ConnectionInput }): Promise<ConnectionTestResult> {
    let target: { host: string; port: number; user: string; password: string; database: string; ssl?: pg.ClientConfig['ssl'] }
    if (input.id) {
      const resolved = this.ctx.resolveConnection(input.id)
      // Allow overriding non-secret fields while keeping the stored password.
      const cfg = input.config
      target = {
        host: cfg?.host ?? resolved.host,
        port: cfg?.port ?? resolved.port,
        user: cfg?.username ?? resolved.username,
        password: cfg?.password || resolved.password,
        database: cfg?.defaultDatabase ?? resolved.defaultDatabase,
      }
    } else {
      const cfg = input.config
      if (!cfg?.password || !cfg.host || !cfg.port || !cfg.username || !cfg.defaultDatabase) {
        throw new BadRequestError('Provide a connection id or full credentials to test')
      }
      target = {
        host: cfg.host,
        port: cfg.port,
        user: cfg.username,
        password: cfg.password,
        database: cfg.defaultDatabase,
      }
    }

    const client = new pg.Client({
      ...target,
      connectionTimeoutMillis: TEST_TIMEOUT_MS,
      query_timeout: TEST_TIMEOUT_MS,
      application_name: 'pgforge-test',
    })
    const startedAt = Date.now()
    try {
      await client.connect()
      const result = await client.query<{ version: string }>('SELECT version()')
      return {
        ok: true,
        serverVersion: result.rows[0]?.version ?? 'unknown',
        latencyMs: Date.now() - startedAt,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' }
    } finally {
      await client.end().catch(() => {})
    }
  }

  async overview(id: string): Promise<ServerOverview> {
    this.ctx.connections.touchLastUsed(id)
    return this.ctx.pools.withClient(id, undefined, async (client) => {
      const { rows } = await client.query<{
        version: string
        version_num: string
        uptime_seconds: string
        database_count: string
        active_connections: string
        max_connections: string
        is_superuser: boolean
      }>(`
        SELECT version() AS version,
               current_setting('server_version_num') AS version_num,
               extract(epoch FROM now() - pg_postmaster_start_time())::bigint::text AS uptime_seconds,
               (SELECT count(*) FROM pg_database WHERE NOT datistemplate)::text AS database_count,
               (SELECT count(*) FROM pg_stat_activity)::text AS active_connections,
               current_setting('max_connections') AS max_connections,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser
      `)
      const sizes = await client.query<{ total: string | null }>(`
        SELECT sum(pg_database_size(datname))::text AS total
        FROM pg_database
        WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
      `)
      const row = rows[0]!
      return {
        serverVersion: row.version,
        versionNumber: Number(row.version_num),
        uptimeSeconds: Number(row.uptime_seconds),
        totalSizeBytes: Number(sizes.rows[0]?.total ?? 0),
        databaseCount: Number(row.database_count),
        activeConnections: Number(row.active_connections),
        maxConnections: Number(row.max_connections),
        isSuperuser: row.is_superuser,
      }
    })
  }

  /** Throws when the connection is flagged read-only in PgForge. */
  assertWritable(id: string): void {
    const record = this.requireRecord(id)
    if (record.readOnly) {
      throw new ForbiddenError('This connection is marked read-only in PgForge')
    }
  }

  private requireRecord(id: string): ConnectionRecord {
    const record = this.ctx.connections.byId(id)
    if (!record) throw new NotFoundError('Connection not found')
    return record
  }
}

export function resolveForTest(record: ConnectionRecord, key: Buffer) {
  return resolveRecord(record, key)
}
