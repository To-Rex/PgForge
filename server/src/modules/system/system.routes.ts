import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError, UnauthorizedError } from '../../core/errors.js'
import { verifyPassword } from '../../core/crypto.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { bumpTokenGeneration, requireRole } from '../../plugins/auth.js'
import type { AuthService } from '../auth/auth.service.js'
import type { BackupService } from '../backup/backup.service.js'
import type { BackupScheduler } from '../backup/scheduler.js'
import type { MetadataService } from './metadata.service.js'

const CONFIRM_PHRASE = 'RESET'

const resetSchema = z.object({
  password: z.string().min(1).max(200),
  confirm: z.string(),
})

const revealSchema = z.object({ password: z.string().min(1).max(200) })

const metadataConnectionSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().max(128),
  password: z.string().max(512),
  sslMode: z.enum(['disable', 'require', 'verify-ca', 'verify-full']),
})

// Fields are what the settings form sends; a raw DSN stays valid for scripted
// setups that already have one.
const metadataSchema = z
  .object({
    connection: metadataConnectionSchema.optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    createDatabase: z.boolean().optional(),
  })
  .refine((body) => body.connection !== undefined || body.url !== undefined, {
    message: 'Provide either connection fields or a connection string',
  })

/**
 * Factory reset — returns the platform to its first-run state. Requires the
 * acting administrator's password and the literal confirmation phrase.
 * Managed PostgreSQL servers are never touched; only PgForge's own data
 * (users, connections, backups, schedules, settings, audit) is erased.
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: AuthService,
  backups: BackupService,
  scheduler: BackupScheduler,
  metadata: MetadataService,
): void {
  // ── Where PgForge keeps its own data ──────────────────────────────────────
  // Admin-only throughout: the DSN is a credential, and the setting decides
  // whether the platform survives the next deploy.
  app.get('/api/system/metadata', { preHandler: requireRole('admin') }, async () => metadata.status())

  app.post(
    '/api/system/metadata/test',
    { preHandler: requireRole('admin') },
    async (req) => {
      const body = parse(metadataSchema, req.body)
      return metadata.test(body, body.createDatabase ?? false)
    },
  )

  app.put('/api/system/metadata', { preHandler: requireRole('admin') }, async (req) => {
    const body = parse(metadataSchema, req.body)
    const result = await metadata.save(body, body.createDatabase ?? false)
    ctx.audit.log({
      actor: { id: req.currentUser.id, email: req.currentUser.email },
      action: 'system.metadata.configure',
      target: 'postgres',
      ip: req.ip,
    })
    return result
  })

  app.delete('/api/system/metadata', { preHandler: requireRole('admin') }, async (req) => {
    const result = metadata.disable()
    ctx.audit.log({
      actor: { id: req.currentUser.id, email: req.currentUser.email },
      action: 'system.metadata.configure',
      target: 'sqlite',
      ip: req.ip,
    })
    return result
  })

  app.post('/api/system/metadata/flush', { preHandler: requireRole('admin') }, async () =>
    metadata.flush(),
  )

  /**
   * Reveals the master secret so an administrator can pin an auto-generated one
   * into the platform environment.
   *
   * Without this the operator is stuck: the snapshot restores every connection,
   * but the key that decrypts their passwords lived in DATA_DIR and is gone.
   * Setting a *new* APP_SECRET would not help — it has to be this one.
   *
   * Guarded like the factory reset: admin, plus their own password, and audited.
   */
  app.post('/api/system/app-secret/reveal', { preHandler: requireRole('admin') }, async (req) => {
    const body = parse(revealSchema, req.body)
    const actor = auth.users.byId(req.currentUser.id)
    if (!actor || !verifyPassword(body.password, actor.passwordHash)) {
      throw new UnauthorizedError('Password is incorrect')
    }
    ctx.audit.log({
      actor: { id: actor.id, email: actor.email },
      action: 'system.app_secret.reveal',
      ip: req.ip,
    })
    req.log.warn({ by: actor.email, ip: req.ip }, 'APP_SECRET revealed to an administrator')
    return {
      secret: ctx.config.masterSecret,
      envLine: `APP_SECRET=${ctx.config.masterSecret}`,
    }
  })

  app.post('/api/system/factory-reset', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = parse(resetSchema, req.body)
    if (body.confirm !== CONFIRM_PHRASE) {
      throw new BadRequestError(`Type ${CONFIRM_PHRASE} to confirm`)
    }
    const actor = auth.users.byId(req.currentUser.id)
    if (!actor || !verifyPassword(body.password, actor.passwordHash)) {
      throw new UnauthorizedError('Password is incorrect')
    }

    // Recorded before the wipe so the operator identity is at least logged
    // server-side; the audit table itself is part of what gets erased.
    req.log.warn({ by: actor.email, ip: req.ip }, 'FACTORY RESET requested — wiping all platform data')

    scheduler.stop()
    ctx.jobs.cancelAll('Factory reset')
    await backups.wipeAllFiles()
    await ctx.pools.closeAll()
    ctx.store.wipeAll()
    ctx.jobs.clearLive()
    // Invalidate every outstanding access token (including the caller's).
    bumpTokenGeneration()

    reply.clearCookie('pgforge_session', { path: '/api/auth' })
    return { ok: true, needsSetup: true }
  })
}
