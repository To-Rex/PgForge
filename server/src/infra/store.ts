import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE connections (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    host             TEXT NOT NULL,
    port             INTEGER NOT NULL,
    username         TEXT NOT NULL,
    password_enc     TEXT NOT NULL,
    default_database TEXT NOT NULL,
    ssl_mode         TEXT NOT NULL,
    color            TEXT,
    read_only        INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    last_used_at     TEXT
  );

  CREATE TABLE query_history (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    database      TEXT NOT NULL,
    sql           TEXT NOT NULL,
    ok            INTEGER NOT NULL,
    error         TEXT,
    duration_ms   INTEGER NOT NULL,
    row_count     INTEGER,
    executed_at   TEXT NOT NULL
  );
  CREATE INDEX idx_history_user ON query_history(user_id, executed_at DESC);

  CREATE TABLE jobs (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    status        TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    database      TEXT NOT NULL,
    log           TEXT NOT NULL DEFAULT '',
    error         TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT
  );

  CREATE TABLE backups (
    id            TEXT PRIMARY KEY,
    job_id        TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    database      TEXT NOT NULL,
    format        TEXT NOT NULL,
    mode          TEXT NOT NULL,
    status        TEXT NOT NULL,
    file_name     TEXT NOT NULL,
    size_bytes    INTEGER,
    error         TEXT,
    duration_ms   INTEGER,
    schedule_id   TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_backups_created ON backups(created_at DESC);

  CREATE TABLE backup_schedules (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    database      TEXT NOT NULL,
    cron          TEXT NOT NULL,
    format        TEXT NOT NULL,
    retention     INTEGER NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id            TEXT PRIMARY KEY,
    user_id       TEXT,
    user_email    TEXT,
    action        TEXT NOT NULL,
    target        TEXT,
    connection_id TEXT,
    database      TEXT,
    details       TEXT,
    ip            TEXT,
    status        TEXT NOT NULL DEFAULT 'ok',
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
  `,
  // v2 — backup inspections (temporary databases restored from backup files)
  `
  CREATE TABLE backup_inspections (
    backup_id     TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    database      TEXT NOT NULL,
    job_id        TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  `,
]

export type SqlParams = Record<string, string | number | null>

/**
 * Thin typed wrapper around the embedded metadata store (node:sqlite).
 * Repositories own row<->domain mapping; this class owns lifecycle and
 * migrations.
 */
export class MetaStore {
  private readonly db: DatabaseSync

  constructor(fileName: string) {
    if (fileName !== ':memory:') mkdirSync(path.dirname(fileName), { recursive: true })
    this.db = new DatabaseSync(fileName)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    let version = row.user_version
    while (version < MIGRATIONS.length) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[version]!)
        version += 1
        this.db.exec(`PRAGMA user_version = ${version}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  all<T>(sql: string, params: SqlParams = {}): T[] {
    return this.db.prepare(sql).all(params) as T[]
  }

  get<T>(sql: string, params: SqlParams = {}): T | undefined {
    return this.db.prepare(sql).get(params) as T | undefined
  }

  run(sql: string, params: SqlParams = {}): { changes: number } {
    const result = this.db.prepare(sql).run(params)
    return { changes: Number(result.changes) }
  }

  close(): void {
    this.db.close()
  }
}
