import path from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { makeConnectionResolver, type AppContext } from './context.js'
import { JobManager } from './infra/jobs.js'
import { PgPoolManager } from './infra/pg.js'
import { MetaStore } from './infra/store.js'
import { AuditService } from './modules/audit/audit.service.js'
import { AuthService } from './modules/auth/auth.service.js'
import { BackupRepo } from './modules/backup/backup.repo.js'
import { BackupService } from './modules/backup/backup.service.js'
import { BackupScheduler } from './modules/backup/scheduler.js'
import { ConnectionsRepo } from './modules/connections/connections.repo.js'
import { ConnectionsService } from './modules/connections/connections.service.js'
import { DataService } from './modules/data/data.service.js'
import { ErdService } from './modules/erd/erd.service.js'
import { InspectorService } from './modules/inspector/inspector.service.js'
import { MonitorService } from './modules/monitor/monitor.service.js'
import { PgRolesService } from './modules/pgroles/pgroles.service.js'
import { HistoryRepo } from './modules/sql/history.repo.js'
import { SqlService } from './modules/sql/sql.service.js'

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
  const store = new MetaStore(path.join(config.dataDir, 'pgforge.db'))
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
  const sql = new SqlService(ctx, history)
  const backupRepo = new BackupRepo(store)
  const backups = new BackupService(ctx, backupRepo)
  const scheduler = new BackupScheduler(ctx, backupRepo, backups, (msg) => app.log.warn(msg))
  const monitor = new MonitorService(ctx)
  const pgroles = new PgRolesService(ctx)
  const erd = new ErdService(ctx)

  const app = await buildApp(ctx, {
    auth,
    connections: connectionsService,
    inspector,
    data,
    sql,
    history,
    backups,
    backupRepo,
    scheduler,
    monitor,
    pgroles,
    erd,
  })

  if (config.secretSource === 'file') {
    app.log.info(
      `APP_SECRET not set — using the auto-generated secret persisted in ${path.join(config.dataDir, 'secret.key')}. Set APP_SECRET explicitly for managed deployments.`,
    )
  }

  scheduler.start()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`Received ${signal}, shutting down`)
    scheduler.stop()
    ctx.jobs.shutdown()
    await app.close()
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
