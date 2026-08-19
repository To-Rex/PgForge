import { MIN_PASSWORD_LENGTH, type AuthResponse, type CreatedInvitation, type InvitationPreview } from '@pgforge/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { DeliveryService } from '../delivery/delivery.service.js'
import type { InvitationsService } from './invitations.service.js'

const createSchema = z.object({
  email: z.string().email().max(200),
  role: z.enum(['admin', 'editor', 'viewer']),
})

const acceptSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(1).max(100),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
})

const tokenParam = z.object({ token: z.string().min(20).max(200) })

/** Public origin for links: explicit PUBLIC_URL, else derived from the request. */
function publicOrigin(req: FastifyRequest, configured: string | undefined): string {
  if (configured) return configured.replace(/\/+$/, '')
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0] ?? req.headers.host
  return `${proto}://${host}`
}

export function registerPublicInvitationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  invitations: InvitationsService,
  signIn: (reply: FastifyReply, userId: string, req: FastifyRequest) => AuthResponse,
): void {
  app.get('/api/invitations/:token', async (req): Promise<InvitationPreview> => {
    const { token } = parse(tokenParam, req.params)
    return invitations.preview(token)
  })

  app.post('/api/invitations/accept', async (req, reply): Promise<AuthResponse> => {
    const body = parse(acceptSchema, req.body)
    const user = invitations.accept(body)
    ctx.audit.log({
      actor: { id: user.id, email: user.email },
      action: 'invitation.accept',
      target: user.email,
      details: `role=${user.role}`,
      ip: req.ip,
    })
    return signIn(reply, user.id, req)
  })
}

export function registerInvitationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  invitations: InvitationsService,
  delivery: DeliveryService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.get('/api/invitations', { preHandler: requireRole('admin') }, async () => invitations.list())

  app.post('/api/invitations', { preHandler: requireRole('admin') }, async (req): Promise<CreatedInvitation> => {
    const body = parse(createSchema, req.body)
    const { invitation, token } = invitations.create(body, req.currentUser.email)
    const acceptUrl = `${publicOrigin(req, ctx.config.publicUrl)}/invite/${token}`

    let emailSent = false
    let emailError: string | null = null
    if (delivery.emailConfigured()) {
      try {
        await delivery.sendMail(
          invitation.email,
          'You are invited to PgForge',
          [
            `${req.currentUser.name} invited you to PgForge (role: ${invitation.role}).`,
            '',
            'Open this one-time link to create your account:',
            acceptUrl,
            '',
            `The link works once and expires on ${invitation.expiresAt.slice(0, 10)}.`,
          ].join('\n'),
        )
        invitations.markEmailSent(invitation.id)
        emailSent = true
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err)
      }
    }

    ctx.audit.log({
      actor: actor(req),
      action: 'invitation.create',
      target: invitation.email,
      details: `role=${invitation.role} emailSent=${emailSent}${emailError ? ` error=${emailError}` : ''}`,
      ip: req.ip,
    })
    return { invitation: { ...invitation, emailSent }, acceptUrl, emailSent, emailError }
  })

  app.delete('/api/invitations/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string }
    invitations.revoke(id)
    ctx.audit.log({ actor: actor(req), action: 'invitation.revoke', target: id, ip: req.ip })
    return { ok: true }
  })
}
