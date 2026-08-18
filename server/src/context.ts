import type { AppConfig } from './config.js'
import { AppError, NotFoundError } from './core/errors.js'
import { decryptSecret } from './core/crypto.js'
import type { JobManager } from './infra/jobs.js'
import type { PgPoolManager, ResolvedConnection } from './infra/pg.js'
import type { MetaStore } from './infra/store.js'
import type { AuditService } from './modules/audit/audit.service.js'
import type { ConnectionRecord, ConnectionsRepo } from './modules/connections/connections.repo.js'

/** Dependencies shared across modules; wired once at boot in index.ts. */
export interface AppContext {
  config: AppConfig
  store: MetaStore
  pools: PgPoolManager
  jobs: JobManager
  audit: AuditService
  connections: ConnectionsRepo
  resolveConnection: (id: string) => ResolvedConnection
}

export function makeConnectionResolver(
  repo: ConnectionsRepo,
  credentialKey: Buffer,
): (id: string) => ResolvedConnection {
  return (id) => {
    const record = repo.byId(id)
    if (!record) throw new NotFoundError('Connection not found')
    return resolveRecord(record, credentialKey)
  }
}

export function resolveRecord(record: ConnectionRecord, credentialKey: Buffer): ResolvedConnection {
  let password: string
  try {
    password = decryptSecret(record.passwordEnc, credentialKey)
  } catch {
    throw new AppError(
      409,
      'credentials_unreadable',
      `Stored credentials for connection "${record.name}" cannot be decrypted — the server's APP_SECRET has changed. Edit the connection and re-enter its password.`,
    )
  }
  return {
    id: record.id,
    host: record.host,
    port: record.port,
    username: record.username,
    password,
    defaultDatabase: record.defaultDatabase,
    sslMode: record.sslMode,
    readOnly: record.readOnly,
  }
}
