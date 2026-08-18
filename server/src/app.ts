import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppMeta } from '@pgforge/shared'
import { AppError, isPgError } from './core/errors.js'
import type { AppContext } from './context.js'
import { authenticate } from './plugins/auth.js'
import { registerAuditRoutes } from './modules/audit/audit.routes.js'
import { registerPublicAuthRoutes, registerUserRoutes } from './modules/auth/auth.routes.js'
import type { AuthService } from './modules/auth/auth.service.js'
import type { BackupRepo } from './modules/backup/backup.repo.js'
import { registerBackupRoutes } from './modules/backup/backup.routes.js'
import type { BackupService } from './modules/backup/backup.service.js'
import type { BackupScheduler } from './modules/backup/scheduler.js'
import { registerConnectionRoutes } from './modules/connections/connections.routes.js'
import type { ConnectionsService } from './modules/connections/connections.service.js'
import { registerDeliveryRoutes } from './modules/delivery/delivery.routes.js'
import type { DeliveryService } from './modules/delivery/delivery.service.js'
import { registerDataRoutes } from './modules/data/data.routes.js'
import type { DataService } from './modules/data/data.service.js'
import { registerErdRoutes } from './modules/erd/erd.routes.js'
import type { ErdService } from './modules/erd/erd.service.js'
import { registerInspectorRoutes } from './modules/inspector/inspector.routes.js'
import type { InspectorService } from './modules/inspector/inspector.service.js'
import { registerMonitorRoutes } from './modules/monitor/monitor.routes.js'
import type { MonitorService } from './modules/monitor/monitor.service.js'
import { registerPgRoleRoutes } from './modules/pgroles/pgroles.routes.js'
import type { PgRolesService } from './modules/pgroles/pgroles.service.js'
import type { HistoryRepo } from './modules/sql/history.repo.js'
import { registerSqlRoutes } from './modules/sql/sql.routes.js'
import type { SqlService } from './modules/sql/sql.service.js'

const execFileAsync = promisify(execFile)
const APP_VERSION = '1.0.0'

export interface Services {
  auth: AuthService
  connections: ConnectionsService
  inspector: InspectorService
  data: DataService
  sql: SqlService
  history: HistoryRepo
  backups: BackupService
  backupRepo: BackupRepo
  scheduler: BackupScheduler
  monitor: MonitorService
  pgroles: PgRolesService
  erd: ErdService
  delivery: DeliveryService
}

export async function buildApp(ctx: AppContext, services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      ctx.config.env === 'development'
        ? { level: 'info', transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : { level: 'info' },
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: true,
  })

  await app.register(cookie)
  await app.register(jwt, { secret: ctx.config.jwtSecret })
  await app.register(multipart)
  if (ctx.config.corsOrigins.length > 0) {
    await app.register(cors, { origin: ctx.config.corsOrigins, credentials: true })
  }

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      void reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } })
      return
    }
    if (isPgError(err)) {
      // A PostgreSQL error surfaced outside the SQL editor path (DDL helpers etc).
      void reply.status(400).send({
        error: { code: 'pg_error', message: err.message, details: { detail: err.detail, hint: err.hint } },
      })
      return
    }
    const fastifyErr = err as { statusCode?: number; message: string }
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      void reply
        .status(fastifyErr.statusCode)
        .send({ error: { code: 'request_error', message: fastifyErr.message } })
      return
    }
    req.log.error({ err }, 'Unhandled error')
    void reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } })
  })

  // ── Public ──────────────────────────────────────────────────────────────
  registerPublicAuthRoutes(app, ctx, services.auth)

  let pgToolsVersion: string | null | undefined
  app.get('/api/meta', async (): Promise<AppMeta> => {
    if (pgToolsVersion === undefined) {
      pgToolsVersion = await execFileAsync(ctx.config.tools.pgDump, ['--version'])
        .then((r) => r.stdout.trim())
        .catch(() => null)
    }
    return {
      version: APP_VERSION,
      pgToolsAvailable: pgToolsVersion !== null,
      pgToolsVersion,
    }
  })

  // ── Protected ───────────────────────────────────────────────────────────
  await app.register(async (scope) => {
    scope.addHook('onRequest', authenticate)
    registerUserRoutes(scope, ctx, services.auth)
    registerConnectionRoutes(scope, ctx, services.connections)
    registerInspectorRoutes(scope, ctx, services.inspector, services.connections)
    registerDataRoutes(scope, ctx, services.data, services.connections)
    registerSqlRoutes(scope, ctx, services.sql, services.history)
    registerBackupRoutes(scope, ctx, services.backups, services.backupRepo, services.scheduler, services.connections)
    registerMonitorRoutes(scope, ctx, services.monitor)
    registerPgRoleRoutes(scope, ctx, services.pgroles, services.connections)
    registerErdRoutes(scope, services.erd)
    registerDeliveryRoutes(scope, ctx, services.delivery)
    registerAuditRoutes(scope, ctx)
  })

  // ── Static web app (production build) ───────────────────────────────────
  const webDist = path.resolve(import.meta.dirname, '../../web/dist')
  const hasWebBuild = existsSync(path.join(webDist, 'index.html'))
  if (hasWebBuild) {
    // Default wildcard mode resolves files per-request, so a rebuilt web bundle
    // (new hashed asset names) is served without restarting the server; missing
    // files fall through to the not-found handler below for the SPA fallback.
    await app.register(fastifyStatic, { root: webDist })
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      void reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } })
      return
    }
    if (hasWebBuild) {
      void reply.sendFile('index.html')
      return
    }
    void reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } })
  })

  return app
}
