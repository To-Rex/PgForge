import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { makeConnectionResolver, type AppContext } from './context.js'
import { JobManager } from './infra/jobs.js'
import { PgPoolManager } from './infra/pg.js'
import { PostgresMetadataBackend } from './infra/metadata-pg.js'
import { MetadataSync } from './infra/metadata-sync.js'
import { MetaStore } from './infra/store.js'
import { AuditService } from './modules/audit/audit.service.js'
import { AuthService } from './modules/auth/auth.service.js'
import { InvitationsService } from './modules/auth/invitations.service.js'
import { BackupRepo } from './modules/backup/backup.repo.js'
import { BackupService } from './modules/backup/backup.service.js'
import { BackupScheduler } from './modules/backup/scheduler.js'
import { ConnectionsRepo } from './modules/connections/connections.repo.js'
import { ConnectionsService } from './modules/connections/connections.service.js'
import { DeliveryService } from './modules/delivery/delivery.service.js'
import { DataService } from './modules/data/data.service.js'
import { ErdService } from './modules/erd/erd.service.js'
import { InspectorService } from './modules/inspector/inspector.service.js'
import { AdviceService } from './modules/monitor/advice.service.js'
import { MonitorService } from './modules/monitor/monitor.service.js'
import { PgRolesService } from './modules/pgroles/pgroles.service.js'
import { SearchService } from './modules/search/search.service.js'
import { HistoryRepo } from './modules/sql/history.repo.js'
import { SavedQueryRepo } from './modules/sql/saved.repo.js'
import { SqlService } from './modules/sql/sql.service.js'
import { MetadataService } from './modules/system/metadata.service.js'

async function main(): Promise<void> {
  // Load a .env file when present (server dir or repo root). Variables already
  // set in the environment take precedence, matching Node's --env-file rules.
  for (const candidate of ['.env', '../.env']) {
    try {
      process.loadEnvFile(path.resolve(candidate))
      break
    } catch {
      /* no .env file at this location */
    }
  }

  const config = loadConfig()

  // Composition root — everything is wired exactly once, here.
  const storePath = path.join(config.dataDir, 'pgforge.db')

  // With METADATA_URL set, the durable copy in PostgreSQL is authoritative:
  // restore it before opening the store, so a container that lost its volume
  // comes back with the platform intact instead of asking for setup again.
  let metadataBackend: PostgresMetadataBackend | null = null
  if (config.metadataUrl) {
    metadataBackend = new PostgresMetadataBackend(config.metadataUrl)
    await metadataBackend.init()
    const snapshot = await metadataBackend.load()
    if (snapshot) {
      // Never silently discard a local database: a stale snapshot would
      // otherwise shadow data written while METADATA_URL was unset.
      if (existsSync(storePath)) {
        copyFileSync(storePath, `${storePath}.local-${Date.now()}.bak`)
      }
      // A stale write-ahead log would be replayed on top of the restored image.
      for (const sidecar of ['-wal', '-shm']) {
        const file = `${storePath}${sidecar}`
        if (existsSync(file)) rmSync(file, { force: true })
      }
      mkdirSync(path.dirname(storePath), { recursive: true })
      writeFileSync(storePath, snapshot)
    }
  }

  let metadataSync: MetadataSync | null = null
  const store = new MetaStore(storePath, () => metadataSync?.markDirty())
  const connections = new ConnectionsRepo(store)
  const pools = new PgPoolManager(makeConnectionResolver(connections, config.credentialKey))
  const jobs = new JobManager(store)
  const audit = new AuditService(store)
  const ctx: AppContext = {
    config,
    store,
    pools,
    jobs,
    audit,
    connections,
    resolveConnection: makeConnectionResolver(connections, config.credentialKey),
  }

  const auth = new AuthService(store)
  const connectionsService = new ConnectionsService(ctx)
  const inspector = new InspectorService(ctx)
  const data = new DataService(ctx, inspector)
  const history = new HistoryRepo(store)
  const savedQueries = new SavedQueryRepo(store)
  const search = new SearchService(ctx)
  const sql = new SqlService(ctx, history)
  const backupRepo = new BackupRepo(store)
  const backups = new BackupService(ctx, backupRepo)
  const scheduler = new BackupScheduler(ctx, backupRepo, backups, (msg) => app.log.warn(msg))
  const monitor = new MonitorService(ctx)
  const advice = new AdviceService(ctx)
  const pgroles = new PgRolesService(ctx)
  const erd = new ErdService(ctx)
  const delivery = new DeliveryService(ctx, backups)
  const invitations = new InvitationsService(store)
  if (metadataBackend) {
    // The logger is read lazily: `app` is built further down, and nothing here
    // logs before then.
    metadataSync = new MetadataSync(store, metadataBackend, config.version, (level, message) =>
      app.log[level](message),
    )
  }
  const metadata = new MetadataService(ctx, metadataSync)
  backups.setAutoDeliveryHook((backupId) => delivery.autoSend(backupId))

  const app = await buildApp(ctx, {
    auth,
    connections: connectionsService,
    inspector,
    data,
    sql,
    history,
    savedQueries,
    search,
    advice,
    backups,
    backupRepo,
    scheduler,
    monitor,
    pgroles,
    erd,
    delivery,
    invitations,
    metadata,
  })

  if (config.metadataUrl) {
    app.log.info(`Metadata store replicated to PostgreSQL (${metadataBackend!.masked})`)
  }

  if (config.metadataUrl && config.secretSource === 'file') {
    app.log.warn(
      'METADATA_URL is set but APP_SECRET is not: the metadata store will survive a redeploy, ' +
        'but the key that decrypts stored connection passwords lives in DATA_DIR and will not. ' +
        'Pin the current secret via Settings -> Application database before redeploying.',
    )
  }

  if (config.secretSource === 'file') {
    app.log.info(
      `APP_SECRET not set — using the auto-generated secret persisted in ${path.join(config.dataDir, 'secret.key')}. Set APP_SECRET explicitly for managed deployments.`,
    )
  }

  // Migrations may have run on top of a restored image; persist that now
  // rather than waiting for the first user write.
  if (metadataSync) await metadataSync.flush()

  scheduler.start()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`Received ${signal}, shutting down`)
    scheduler.stop()
    ctx.jobs.shutdown()
    await app.close()
    // Last write wins: flush after the API stops accepting new ones.
    await metadataSync?.stop().catch((err: unknown) => {
      app.log.warn(`Final metadata flush failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    await pools.shutdown()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ port: config.port, host: config.host })
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
