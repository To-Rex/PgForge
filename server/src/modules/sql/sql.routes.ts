import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { truncate } from '../../core/util.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import type { HistoryRepo } from './history.repo.js'
import type { SqlService } from './sql.service.js'

const executeSchema = z.object({
  sql: z.string().min(1).max(500_000),
  execId: z.string().min(8).max(64),
  maxRows: z.number().int().min(1).optional(),
  timeoutMs: z.number().int().min(100).optional(),
})

const cancelSchema = z.object({ execId: z.string().min(8).max(64) })

const explainSchema = z.object({
  sql: z.string().min(1).max(100_000),
  analyze: z.boolean().optional(),
})

const historyQuerySchema = z.object({
  connectionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

type DbParams = { connId: string; db: string }

export function registerSqlRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  sql: SqlService,
  history: HistoryRepo,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.post('/api/connections/:connId/db/:db/sql/execute', async (req) => {
    const { connId, db } = req.params as DbParams
    const body = parse(executeSchema, req.body)
    const response = await sql.execute(
      connId,
      db,
      { id: req.currentUser.id, readOnly: req.currentUser.role === 'viewer' },
      body,
    )
    ctx.audit.log({
      actor: actor(req),
      action: 'sql.execute',
      connectionId: connId,
      database: db,
      details: truncate(body.sql, 500),
      status: response.ok ? 'ok' : 'error',
      ip: req.ip,
    })
    return response
  })

  app.post('/api/connections/:connId/sql/cancel', async (req) => {
    const { connId } = req.params as { connId: string }
    const body = parse(cancelSchema, req.body)
    const canceled = await sql.cancel(connId, body.execId)
    return { canceled }
  })

  app.post('/api/connections/:connId/db/:db/sql/explain', async (req) => {
    const { connId, db } = req.params as DbParams
    const body = parse(explainSchema, req.body)
    return sql.explain(
      connId,
      db,
      { readOnly: req.currentUser.role === 'viewer' },
      body.sql,
      body.analyze ?? false,
    )
  })

  app.get('/api/history', async (req) => {
    const query = parse(historyQuerySchema, req.query)
    return history.list(req.currentUser.id, query.connectionId, query.limit)
  })

  app.delete('/api/history', async (req) => {
    history.clear(req.currentUser.id)
    return { ok: true }
  })
}
