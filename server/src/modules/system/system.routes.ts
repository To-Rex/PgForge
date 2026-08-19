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

const CONFIRM_PHRASE = 'RESET'

const resetSchema = z.object({
  password: z.string().min(1).max(200),
  confirm: z.string(),
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
): void {
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
