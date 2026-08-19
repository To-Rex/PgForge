import type { AppRole } from '@pgforge/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ForbiddenError, UnauthorizedError } from '../core/errors.js'
import { hasRole } from '../core/roles.js'

export interface AuthUser {
  id: string
  email: string
  name: string
  role: AppRole
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: AuthUser
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; name: string; role: AppRole; gen?: number }
    user: { sub: string; email: string; name: string; role: AppRole; gen?: number }
  }
}

/**
 * Access-token generation. Access tokens are stateless JWTs, so wiping the
 * database alone cannot revoke ones already issued. Bumping the generation
 * (factory reset) makes every earlier token fail verification instantly.
 */
let tokenGeneration = 1
export const currentTokenGeneration = (): number => tokenGeneration
export const bumpTokenGeneration = (): void => {
  tokenGeneration += 1
}

/** onRequest hook for protected scopes: verifies the bearer token. */
export async function authenticate(req: FastifyRequest): Promise<void> {
  try {
    await req.jwtVerify()
  } catch {
    throw new UnauthorizedError()
  }
  const payload = req.user
  if ((payload.gen ?? 0) !== tokenGeneration) throw new UnauthorizedError()
  req.currentUser = {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    role: payload.role,
  }
}

/** preHandler factory enforcing a minimum platform role. */
export function requireRole(required: AppRole) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.currentUser) throw new UnauthorizedError()
    if (!hasRole(req.currentUser.role, required)) {
      throw new ForbiddenError(`This action requires the '${required}' role`)
    }
  }
}
