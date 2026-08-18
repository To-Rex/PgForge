import type { ConnectionSummary, SslMode } from '@pgforge/shared'
import { nowIso } from '../../core/util.js'
import type { MetaStore } from '../../infra/store.js'

export interface ConnectionRecord {
  id: string
  name: string
  host: string
  port: number
  username: string
  passwordEnc: string
  defaultDatabase: string
  sslMode: SslMode
  color: string | null
  readOnly: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

interface Row {
  id: string
  name: string
  host: string
  port: number
  username: string
  password_enc: string
  default_database: string
  ssl_mode: string
  color: string | null
  read_only: number
  created_at: string
  updated_at: string
  last_used_at: string | null
}

const toRecord = (r: Row): ConnectionRecord => ({
  id: r.id,
  name: r.name,
  host: r.host,
  port: r.port,
  username: r.username,
  passwordEnc: r.password_enc,
  defaultDatabase: r.default_database,
  sslMode: r.ssl_mode as SslMode,
  color: r.color,
  readOnly: r.read_only === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
})

export const toSummary = (c: ConnectionRecord): ConnectionSummary => ({
  id: c.id,
  name: c.name,
  host: c.host,
  port: c.port,
  username: c.username,
  defaultDatabase: c.defaultDatabase,
  sslMode: c.sslMode,
  color: c.color,
  readOnly: c.readOnly,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  lastUsedAt: c.lastUsedAt,
})

export class ConnectionsRepo {
  constructor(private readonly store: MetaStore) {}

  list(): ConnectionRecord[] {
    return this.store.all<Row>('SELECT * FROM connections ORDER BY name').map(toRecord)
  }

  byId(id: string): ConnectionRecord | undefined {
    const row = this.store.get<Row>('SELECT * FROM connections WHERE id = :id', { id })
    return row ? toRecord(row) : undefined
  }

  insert(record: ConnectionRecord): void {
    this.store.run(
      `INSERT INTO connections
         (id, name, host, port, username, password_enc, default_database, ssl_mode, color, read_only, created_at, updated_at)
       VALUES
         (:id, :name, :host, :port, :username, :passwordEnc, :defaultDatabase, :sslMode, :color, :readOnly, :createdAt, :updatedAt)`,
      {
        id: record.id,
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        passwordEnc: record.passwordEnc,
        defaultDatabase: record.defaultDatabase,
        sslMode: record.sslMode,
        color: record.color,
        readOnly: record.readOnly ? 1 : 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    )
  }

  update(record: ConnectionRecord): void {
    this.store.run(
      `UPDATE connections SET
         name = :name, host = :host, port = :port, username = :username,
         password_enc = :passwordEnc, default_database = :defaultDatabase,
         ssl_mode = :sslMode, color = :color, read_only = :readOnly, updated_at = :updatedAt
       WHERE id = :id`,
      {
        id: record.id,
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        passwordEnc: record.passwordEnc,
        defaultDatabase: record.defaultDatabase,
        sslMode: record.sslMode,
        color: record.color,
        readOnly: record.readOnly ? 1 : 0,
        updatedAt: nowIso(),
      },
    )
  }

  touchLastUsed(id: string): void {
    this.store.run('UPDATE connections SET last_used_at = :now WHERE id = :id', {
      id,
      now: nowIso(),
    })
  }

  delete(id: string): boolean {
    return this.store.run('DELETE FROM connections WHERE id = :id', { id }).changes > 0
  }
}
