import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'

const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(100).optional(),
  userId: z.string().uuid().optional(),
  connectionId: z.string().uuid().optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
})

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/audit', { preHandler: requireRole('admin') }, async (req) => {
    const query = parse(auditQuerySchema, req.query)
    return ctx.audit.query(query)
  })

  app.get('/api/audit/actions', { preHandler: requireRole('admin') }, async () =>
    ctx.audit.distinctActions(),
  )
}
