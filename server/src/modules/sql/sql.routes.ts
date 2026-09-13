import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ForbiddenError, NotFoundError } from '../../core/errors.js'
import { truncate } from '../../core/util.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import type { HistoryRepo } from './history.repo.js'
import type { SavedQueryRepo } from './saved.repo.js'
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

const savedCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  sql: z.string().min(1).max(200_000),
  connectionId: z.string().uuid().nullish(),
  shared: z.boolean().optional(),
})

const savedUpdateSchema = savedCreateSchema.partial()

const savedListSchema = z.object({ connectionId: z.string().uuid().optional() })

type DbParams = { connId: string; db: string }

export function registerSqlRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  sql: SqlService,
  history: HistoryRepo,
  saved: SavedQueryRepo,
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

  // ── Saved queries ───────────────────────────────────────────────────────
  // Everyone can keep their own snippets; only the author (or an admin) can
  // change one, so a shared snippet cannot be rewritten under its readers.
  const assertCanWrite = (req: FastifyRequest, id: string) => {
    const existing = saved.byId(id)
    if (!existing) throw new NotFoundError('Saved query not found')
    if (existing.ownerId !== req.currentUser.id && req.currentUser.role !== 'admin') {
      throw new ForbiddenError('Only the author can change this saved query')
    }
    return existing
  }

  app.get('/api/saved-queries', async (req) => {
    const query = parse(savedListSchema, req.query)
    return saved.list(req.currentUser.id, query.connectionId)
  })

  app.post('/api/saved-queries', async (req, reply) => {
    const body = parse(savedCreateSchema, req.body)
    const created = saved.create(req.currentUser.id, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'saved_query.create',
      target: created.name,
      connectionId: created.connectionId ?? undefined,
      ip: req.ip,
    })
    void reply.status(201)
    return created
  })

  app.patch('/api/saved-queries/:id', async (req) => {
    const { id } = req.params as { id: string }
    assertCanWrite(req, id)
    const body = parse(savedUpdateSchema, req.body)
    const updated = saved.update(id, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'saved_query.update',
      target: updated.name,
      connectionId: updated.connectionId ?? undefined,
      ip: req.ip,
    })
    return updated
  })

  app.delete('/api/saved-queries/:id', async (req) => {
    const { id } = req.params as { id: string }
    const existing = assertCanWrite(req, id)
    saved.delete(id)
    ctx.audit.log({
      actor: actor(req),
      action: 'saved_query.delete',
      target: existing.name,
      connectionId: existing.connectionId ?? undefined,
      ip: req.ip,
    })
    return { ok: true }
  })
}
