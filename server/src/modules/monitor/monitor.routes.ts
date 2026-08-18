import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { MonitorService } from './monitor.service.js'

const pidSchema = z.object({ pid: z.number().int().min(1) })

type ConnParams = { connId: string }
type DbParams = ConnParams & { db: string }

export function registerMonitorRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  monitor: MonitorService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.get('/api/connections/:connId/sessions', async (req) => {
    const { connId } = req.params as ConnParams
    return monitor.sessions(connId)
  })

  app.post(
    '/api/connections/:connId/sessions/cancel',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId } = req.params as ConnParams
      const { pid } = parse(pidSchema, req.body)
      const ok = await monitor.signalBackend(connId, pid, 'cancel')
      ctx.audit.log({
        actor: actor(req),
        action: 'session.cancel',
        target: String(pid),
        connectionId: connId,
        ip: req.ip,
      })
      return { ok }
    },
  )

  app.post(
    '/api/connections/:connId/sessions/terminate',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { connId } = req.params as ConnParams
      const { pid } = parse(pidSchema, req.body)
      const ok = await monitor.signalBackend(connId, pid, 'terminate')
      ctx.audit.log({
        actor: actor(req),
        action: 'session.terminate',
        target: String(pid),
        connectionId: connId,
        ip: req.ip,
      })
      return { ok }
    },
  )

  app.get('/api/connections/:connId/locks', async (req) => {
    const { connId } = req.params as ConnParams
    return monitor.locks(connId)
  })

  app.get('/api/connections/:connId/db/:db/stats', async (req) => {
    const { connId, db } = req.params as DbParams
    return monitor.dbStats(connId, db)
  })

  app.get('/api/connections/:connId/db/:db/table-stats', async (req) => {
    const { connId, db } = req.params as DbParams
    return monitor.tableStats(connId, db)
  })

  app.get('/api/connections/:connId/db/:db/slow-queries', async (req) => {
    const { connId, db } = req.params as DbParams
    return monitor.slowQueries(connId, db)
  })
}
