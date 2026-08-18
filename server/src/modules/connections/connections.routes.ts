import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { ConnectionsService } from './connections.service.js'

const connectionInputSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(128),
  password: z.string().max(512).optional(),
  defaultDatabase: z.string().min(1).max(128),
  sslMode: z.enum(['disable', 'require', 'verify-ca', 'verify-full']),
  color: z.string().max(32).nullish(),
  readOnly: z.boolean().optional(),
})

const testSchema = z.object({
  id: z.string().uuid().optional(),
  config: connectionInputSchema.partial().optional(),
})

export function registerConnectionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  service: ConnectionsService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.get('/api/connections', async () => service.list())

  app.get('/api/connections/:id', async (req) => {
    const { id } = req.params as { id: string }
    return service.get(id)
  })

  app.post('/api/connections', { preHandler: requireRole('admin') }, async (req) => {
    const body = parse(connectionInputSchema, req.body)
    const summary = service.create(body)
    ctx.audit.log({
      actor: actor(req),
      action: 'connection.create',
      target: summary.name,
      connectionId: summary.id,
      details: `${summary.username}@${summary.host}:${summary.port}/${summary.defaultDatabase}`,
      ip: req.ip,
    })
    return summary
  })

  app.put('/api/connections/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string }
    const body = parse(connectionInputSchema, req.body)
    const summary = await service.update(id, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'connection.update',
      target: summary.name,
      connectionId: id,
      ip: req.ip,
    })
    return summary
  })

  app.delete('/api/connections/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string }
    const summary = service.get(id)
    await service.delete(id)
    ctx.audit.log({
      actor: actor(req),
      action: 'connection.delete',
      target: summary.name,
      connectionId: id,
      ip: req.ip,
    })
    return { ok: true }
  })

  app.post('/api/connections/test', async (req) => {
    const body = parse(testSchema, req.body)
    return service.test(body as Parameters<ConnectionsService['test']>[0])
  })

  app.get('/api/connections/:id/overview', async (req) => {
    const { id } = req.params as { id: string }
    return service.overview(id)
  })
}
