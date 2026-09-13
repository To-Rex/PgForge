import pg from 'pg'
import type { MetadataSnapshotInfo, MetadataTestResult } from '@pgforge/shared'
import { maskDatabaseUrl } from '../core/env-file.js'

const SCHEMA = 'pgforge'
const TABLE = `${SCHEMA}.metadata_snapshot`
const CONNECT_TIMEOUT_MS = 10_000
/** `CREATE DATABASE` cannot run from inside the database being created. */
const MAINTENANCE_DATABASES = ['postgres', 'template1']
/** PostgreSQL: database does not exist. */
const INVALID_CATALOG = '3D000'

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id          smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  snapshot    bytea        NOT NULL,
  byte_size   bigint       NOT NULL,
  revision    bigint       NOT NULL DEFAULT 1,
  app_version text,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);`

interface SnapshotRow {
  byte_size: string
  revision: string
  updated_at: Date
  app_version: string | null
}

function toInfo(row: SnapshotRow): MetadataSnapshotInfo {
  return {
    byteSize: Number(row.byte_size),
    revision: Number(row.revision),
    updatedAt: row.updated_at.toISOString(),
    appVersion: row.app_version,
  }
}

/**
 * node-postgres does not apply `sslmode` from the DSN consistently across
 * versions, and managed providers routinely present certificates that a strict
 * check rejects. This mirrors the connection module's own policy: verify only
 * when the operator explicitly asked for `verify-full`.
 */
function sslFor(url: string): pg.ClientConfig['ssl'] {
  let mode: string | null = null
  try {
    mode = new URL(url).searchParams.get('sslmode')
  } catch {
    /* handled by the connection attempt itself */
  }
  switch (mode) {
    case 'disable':
    case null:
      return undefined
    case 'verify-full':
      return { rejectUnauthorized: true }
    default:
      return { rejectUnauthorized: false }
  }
}

function clientFor(url: string, databaseOverride?: string): pg.Client {
  const config: pg.ClientConfig = {
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: 'pgforge-metadata',
    ssl: sslFor(url),
  }
  if (databaseOverride) config.database = databaseOverride
  return new pg.Client(config)
}

function databaseOf(url: string): string | null {
  try {
    const name = new URL(url).pathname.replace(/^\//, '')
    return name.length > 0 ? decodeURIComponent(name) : null
  } catch {
    return null
  }
}

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message)
  return 'Connection failed'
}

function codeOf(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) return String(err.code)
  return null
}

/**
 * Keeps PgForge's SQLite image in a PostgreSQL row.
 *
 * The image is stored whole rather than mirrored table-by-table on purpose:
 * it is byte-for-byte the same database the application already runs on, so
 * behaviour, schema and migrations cannot drift between the two backends. The
 * cost is that the snapshot is opaque to SQL and that exactly one server may
 * write it — both acceptable for a single-instance control plane, and both
 * stated in the UI.
 */
export class PostgresMetadataBackend {
  constructor(private readonly url: string) {}

  get masked(): string {
    return maskDatabaseUrl(this.url)
  }

  /** Creates the schema and table if missing. Throws with a usable message. */
  async init(): Promise<void> {
    const client = clientFor(this.url)
    try {
      await client.connect()
    } catch (err) {
      await client.end().catch(() => {})
      throw new Error(
        `Cannot reach the metadata database (${this.masked}): ${messageOf(err)}`,
        { cause: err },
      )
    }
    try {
      await client.query(DDL)
    } finally {
      await client.end().catch(() => {})
    }
  }

  /** The stored image, or null when this database has never been used yet. */
  async load(): Promise<Buffer | null> {
    const client = clientFor(this.url)
    await client.connect()
    try {
      const { rows } = await client.query<{ snapshot: Buffer }>(
        `SELECT snapshot FROM ${TABLE} WHERE id = 1`,
      )
      return rows[0]?.snapshot ?? null
    } finally {
      await client.end().catch(() => {})
    }
  }

  async info(): Promise<MetadataSnapshotInfo | null> {
    const client = clientFor(this.url)
    await client.connect()
    try {
      const { rows } = await client.query<SnapshotRow>(
        `SELECT byte_size, revision, updated_at, app_version FROM ${TABLE} WHERE id = 1`,
      )
      return rows[0] ? toInfo(rows[0]) : null
    } finally {
      await client.end().catch(() => {})
    }
  }

  /** Replaces the stored image. `revision` only ever moves forward. */
  async save(bytes: Buffer, appVersion: string): Promise<MetadataSnapshotInfo> {
    const client = clientFor(this.url)
    await client.connect()
    try {
      const { rows } = await client.query<SnapshotRow>(
        // `AS snap` gives the conflicting row an unambiguous name; a
        // schema-qualified three-part reference in SET is not portable.
        `INSERT INTO ${TABLE} AS snap (id, snapshot, byte_size, revision, app_version, updated_at)
         VALUES (1, $1, $2, 1, $3, now())
         ON CONFLICT (id) DO UPDATE
           SET snapshot = EXCLUDED.snapshot,
               byte_size = EXCLUDED.byte_size,
               revision = snap.revision + 1,
               app_version = EXCLUDED.app_version,
               updated_at = now()
         RETURNING byte_size, revision, updated_at, app_version`,
        [bytes, bytes.length, appVersion],
      )
      return toInfo(rows[0]!)
    } finally {
      await client.end().catch(() => {})
    }
  }

  /**
   * Probes a DSN without changing anything the caller did not ask for.
   * Optionally creates the database when the role is allowed to — managed
   * providers usually are not, hence the explicit opt-in and clear failure.
   */
  static async test(url: string, createDatabase = false): Promise<MetadataTestResult> {
    const empty: MetadataTestResult = {
      ok: false,
      serverVersion: null,
      database: null,
      schemaReady: false,
      snapshot: null,
      databaseCreated: false,
      // Filled in by the caller, which knows how the DSN was assembled.
      maskedUrl: null,
      error: null,
    }

    if (!/^postgres(ql)?:\/\//i.test(url.trim())) {
      return { ...empty, error: 'Connection string must start with postgres:// or postgresql://' }
    }

    let databaseCreated = false
    let client = clientFor(url)
    try {
      await client.connect()
    } catch (err) {
      await client.end().catch(() => {})
      if (codeOf(err) === INVALID_CATALOG && createDatabase) {
        const created = await PostgresMetadataBackend.createDatabase(url)
        if (created.error) return { ...empty, error: created.error }
        databaseCreated = true
        client = clientFor(url)
        try {
          await client.connect()
        } catch (retryErr) {
          await client.end().catch(() => {})
          return { ...empty, error: messageOf(retryErr) }
        }
      } else if (codeOf(err) === INVALID_CATALOG) {
        return {
          ...empty,
          error: `Database "${databaseOf(url) ?? '?'}" does not exist. Create it first, or enable "create the database" and use a role with the CREATEDB privilege.`,
        }
      } else {
        return { ...empty, error: messageOf(err) }
      }
    }

    try {
      const version = await client.query<{ version: string; db: string }>(
        'SELECT version() AS version, current_database() AS db',
      )
      const serverVersion = version.rows[0]?.version ?? null
      const database = version.rows[0]?.db ?? null

      try {
        await client.query(DDL)
      } catch (err) {
        return {
          ...empty,
          serverVersion,
          database,
          databaseCreated,
          error: `Connected, but cannot create the "${SCHEMA}" schema: ${messageOf(err)}`,
        }
      }

      const { rows } = await client.query<SnapshotRow>(
        `SELECT byte_size, revision, updated_at, app_version FROM ${TABLE} WHERE id = 1`,
      )
      return {
        ok: true,
        serverVersion,
        database,
        schemaReady: true,
        snapshot: rows[0] ? toInfo(rows[0]) : null,
        databaseCreated,
        maskedUrl: null,
        error: null,
      }
    } catch (err) {
      return { ...empty, databaseCreated, error: messageOf(err) }
    } finally {
      await client.end().catch(() => {})
    }
  }

  /** Connects to a maintenance database to issue `CREATE DATABASE`. */
  private static async createDatabase(url: string): Promise<{ error: string | null }> {
    const name = databaseOf(url)
    if (!name) return { error: 'Connection string does not name a database' }

    let lastError = 'No maintenance database could be reached'
    for (const maintenance of MAINTENANCE_DATABASES) {
      const client = clientFor(url, maintenance)
      try {
        await client.connect()
      } catch (err) {
        lastError = messageOf(err)
        await client.end().catch(() => {})
        continue
      }
      try {
        const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
        if (exists.rowCount === 0) {
          // Identifiers cannot be parameterized; quote it the same way the rest
          // of the codebase does.
          await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`)
        }
        return { error: null }
      } catch (err) {
        return {
          error: `Cannot create database "${name}": ${messageOf(err)}. The role likely lacks the CREATEDB privilege — create the database manually instead.`,
        }
      } finally {
        await client.end().catch(() => {})
      }
    }
    return { error: lastError }
  }
}
