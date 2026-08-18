import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../core/errors.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { ConnectionsService } from '../connections/connections.service.js'
import type { PgRolesService } from './pgroles.service.js'

const roleName = z.string().min(1).max(63)

const roleInputSchema = z.object({
  name: roleName,
  password: z.string().max(512).optional(),
  login: z.boolean(),
  superuser: z.boolean(),
  createDb: z.boolean(),
  createRole: z.boolean(),
  replication: z.boolean(),
  connLimit: z.number().int().min(-1).max(10_000).optional(),
  validUntil: z.string().max(64).nullish(),
  memberOf: z.array(roleName).max(50).optional(),
})

const roleUpdateSchema = roleInputSchema.omit({ name: true }).partial()

const dropRoleSchema = z.object({ confirmName: z.string() })

const grantSchema = z.object({
  role: roleName,
  schema: z.string().min(1).max(63),
  table: z.string().min(1).max(63).optional(),
  privileges: z
    .array(z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']))
    .min(1),
})

type ConnParams = { connId: string }
type DbParams = ConnParams & { db: string }

export function registerPgRoleRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  service: PgRolesService,
  connections: ConnectionsService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.get('/api/connections/:connId/roles', async (req) => {
    const { connId } = req.params as ConnParams
    return service.list(connId)
  })

  app.post('/api/connections/:connId/roles', { preHandler: requireRole('admin') }, async (req) => {
    const { connId } = req.params as ConnParams
    connections.assertWritable(connId)
    const body = parse(roleInputSchema, req.body)
    await service.create(connId, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'pgrole.create',
      target: body.name,
      connectionId: connId,
      details: `login=${body.login} superuser=${body.superuser}`,
      ip: req.ip,
    })
    return { ok: true }
  })

  app.patch(
    '/api/connections/:connId/roles/:name',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { connId, name } = req.params as ConnParams & { name: string }
      connections.assertWritable(connId)
      const body = parse(roleUpdateSchema, req.body)
      await service.update(connId, name, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'pgrole.update',
        target: name,
        connectionId: connId,
        details: Object.keys(body)
          .filter((k) => k !== 'password')
          .join(','),
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/roles/:name/drop',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { connId, name } = req.params as ConnParams & { name: string }
      connections.assertWritable(connId)
      const body = parse(dropRoleSchema, req.body)
      if (body.confirmName !== name) {
        throw new BadRequestError('Confirmation name does not match the role name')
      }
      await service.drop(connId, name)
      ctx.audit.log({
        actor: actor(req),
        action: 'pgrole.drop',
        target: name,
        connectionId: connId,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.get('/api/connections/:connId/db/:db/grants/:schema/:table', async (req) => {
    const { connId, db, schema, table } = req.params as DbParams & { schema: string; table: string }
    return service.tableGrants(connId, db, schema, table)
  })

  app.post(
    '/api/connections/:connId/db/:db/grants',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      connections.assertWritable(connId)
      const body = parse(grantSchema, req.body)
      const sql = await service.applyGrant(connId, db, body, false)
      ctx.audit.log({
        actor: actor(req),
        action: 'grant.apply',
        target: body.role,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/db/:db/grants/revoke',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      connections.assertWritable(connId)
      const body = parse(grantSchema, req.body)
      const sql = await service.applyGrant(connId, db, body, true)
      ctx.audit.log({
        actor: actor(req),
        action: 'grant.revoke',
        target: body.role,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )
}
