import type { AuthResponse, BootstrapInfo } from '@pgforge/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { UnauthorizedError } from '../../core/errors.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import { toAppUser, type UserRecord } from './users.repo.js'
import type { AuthService } from './auth.service.js'

const REFRESH_COOKIE = 'pgforge_session'
const ACCESS_TTL = '15m'

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
})

const setupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(200),
  password: z.string().min(10).max(200),
})

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(200),
  password: z.string().min(10).max(200),
  role: z.enum(['admin', 'editor', 'viewer']),
})

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(200).optional(),
  password: z.string().min(10).max(200).optional(),
  role: z.enum(['admin', 'editor', 'viewer']).optional(),
})

export function registerPublicAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: AuthService,
): void {
  const signAccessToken = (user: UserRecord) =>
    app.jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role },
      { expiresIn: ACCESS_TTL },
    )

  const setRefreshCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(REFRESH_COOKIE, token, {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.config.env === 'production',
      maxAge: 30 * 24 * 3600,
    })
  }

  const authResponse = (reply: FastifyReply, user: UserRecord, refreshToken: string): AuthResponse => {
    setRefreshCookie(reply, refreshToken)
    return { token: signAccessToken(user), user: toAppUser(user) }
  }

  app.get('/api/auth/bootstrap', async (): Promise<BootstrapInfo> => ({
    needsSetup: auth.needsSetup(),
  }))

  app.post('/api/auth/setup', async (req, reply): Promise<AuthResponse> => {
    const body = parse(setupSchema, req.body)
    const user = auth.setup(body)
    ctx.audit.log({
      actor: { id: user.id, email: user.email },
      action: 'auth.setup',
      ip: req.ip,
    })
    return authResponse(reply, user, auth.issueRefreshToken(user.id, req.ip, req.headers['user-agent'] ?? ''))
  })

  app.post('/api/auth/login', async (req, reply): Promise<AuthResponse> => {
    const body = parse(loginSchema, req.body)
    let user: UserRecord
    try {
      user = auth.login(body.email, body.password, req.ip)
    } catch (err) {
      ctx.audit.log({
        actor: null,
        action: 'auth.login',
        details: `Failed login for ${body.email}`,
        ip: req.ip,
        status: 'denied',
      })
      throw err
    }
    ctx.audit.log({ actor: { id: user.id, email: user.email }, action: 'auth.login', ip: req.ip })
    return authResponse(reply, user, auth.issueRefreshToken(user.id, req.ip, req.headers['user-agent'] ?? ''))
  })

  app.post('/api/auth/refresh', async (req, reply): Promise<AuthResponse> => {
    const token = req.cookies[REFRESH_COOKIE]
    if (!token) throw new UnauthorizedError('No session')
    const rotated = auth.rotateRefreshToken(token, req.ip, req.headers['user-agent'] ?? '')
    return authResponse(reply, rotated.user, rotated.token)
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE]
    if (token) auth.revokeRefreshToken(token)
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
    return { ok: true }
  })
}

export function registerUserRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: AuthService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.get('/api/auth/me', async (req) => {
    const user = auth.users.byId(req.currentUser.id)
    if (!user) throw new UnauthorizedError('User no longer exists')
    return toAppUser(user)
  })

  app.get('/api/users', { preHandler: requireRole('admin') }, async () => auth.listUsers())

  app.post('/api/users', { preHandler: requireRole('admin') }, async (req) => {
    const body = parse(createUserSchema, req.body)
    const user = auth.createUser(body)
    ctx.audit.log({
      actor: actor(req),
      action: 'user.create',
      target: user.email,
      details: `role=${user.role}`,
      ip: req.ip,
    })
    return user
  })

  app.patch('/api/users/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string }
    const body = parse(updateUserSchema, req.body)
    const user = auth.updateUser(id, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'user.update',
      target: user.email,
      details: Object.keys(body).join(','),
      ip: req.ip,
    })
    return user
  })

  app.delete('/api/users/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string }
    auth.deleteUser(id, req.currentUser.id)
    ctx.audit.log({ actor: actor(req), action: 'user.delete', target: id, ip: req.ip })
    return { ok: true }
  })
}
