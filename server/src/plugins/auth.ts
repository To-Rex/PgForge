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
    payload: { sub: string; email: string; name: string; role: AppRole }
    user: { sub: string; email: string; name: string; role: AppRole }
  }
}

/** onRequest hook for protected scopes: verifies the bearer token. */
export async function authenticate(req: FastifyRequest): Promise<void> {
  try {
    await req.jwtVerify()
  } catch {
    throw new UnauthorizedError()
  }
  const payload = req.user
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
