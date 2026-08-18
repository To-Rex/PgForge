import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../core/errors.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { ConnectionsService } from '../connections/connections.service.js'
import type { DataService } from './data.service.js'

const filterSchema = z.object({
  column: z.string().min(1).max(128),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts', 'ends', 'in', 'is_null', 'not_null']),
  value: z.string().max(10_000).optional(),
})

const sortSchema = z.object({
  column: z.string().min(1).max(128),
  dir: z.enum(['asc', 'desc']),
})

const rowsQuerySchema = z.object({
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(500),
  filters: z.array(filterSchema).max(20).optional(),
  sorts: z.array(sortSchema).max(5).optional(),
  search: z.string().max(500).optional(),
})

const rowValues = z.record(z.unknown())

const insertSchema = z.object({ values: rowValues })
const updateSchema = z.object({ pk: rowValues, changes: rowValues })
const deleteSchema = z.object({ pks: z.array(rowValues).min(1).max(1000) })

const exportSchema = z.object({
  format: z.enum(['csv', 'json']),
  filters: z.array(filterSchema).max(20).optional(),
  sorts: z.array(sortSchema).max(5).optional(),
  limit: z.number().int().min(1).max(1_000_000).optional(),
})

type TableParams = { connId: string; db: string; schema: string; table: string }

/** Stream helper with backpressure over the raw HTTP response. */
function rawWriter(reply: FastifyReply): (chunk: string) => Promise<void> {
  return (chunk) =>
    new Promise((resolve, reject) => {
      reply.raw.write(chunk, (err) => (err ? reject(err) : resolve()))
    })
}

export function registerDataRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  data: DataService,
  connections: ConnectionsService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })
  const base = '/api/connections/:connId/db/:db/tables/:schema/:table'

  app.post(`${base}/rows/query`, async (req) => {
    const { connId, db, schema, table } = req.params as TableParams
    const body = parse(rowsQuerySchema, req.body)
    return data.queryRows(connId, db, schema, table, body)
  })

  app.post(`${base}/rows/insert`, { preHandler: requireRole('editor') }, async (req) => {
    const { connId, db, schema, table } = req.params as TableParams
    connections.assertWritable(connId)
    const body = parse(insertSchema, req.body)
    await data.insertRow(connId, db, schema, table, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'data.insert',
      target: `${schema}.${table}`,
      connectionId: connId,
      database: db,
      ip: req.ip,
    })
    return { ok: true }
  })

  app.post(`${base}/rows/update`, { preHandler: requireRole('editor') }, async (req) => {
    const { connId, db, schema, table } = req.params as TableParams
    connections.assertWritable(connId)
    const body = parse(updateSchema, req.body)
    await data.updateRow(connId, db, schema, table, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'data.update',
      target: `${schema}.${table}`,
      connectionId: connId,
      database: db,
      details: `columns: ${Object.keys(body.changes).join(', ')}`,
      ip: req.ip,
    })
    return { ok: true }
  })

  app.post(`${base}/rows/delete`, { preHandler: requireRole('editor') }, async (req) => {
    const { connId, db, schema, table } = req.params as TableParams
    connections.assertWritable(connId)
    const body = parse(deleteSchema, req.body)
    const deleted = await data.deleteRows(connId, db, schema, table, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'data.delete',
      target: `${schema}.${table}`,
      connectionId: connId,
      database: db,
      details: `${deleted} row(s)`,
      ip: req.ip,
    })
    return { ok: true, deleted }
  })

  app.post(`${base}/export`, async (req, reply) => {
    const { connId, db, schema, table } = req.params as TableParams
    const body = parse(exportSchema, req.body)
    const ext = body.format === 'csv' ? 'csv' : 'json'
    reply.raw.writeHead(200, {
      'content-type': body.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${schema}.${table}.${ext}"`,
    })
    const rows = await data.export(connId, db, schema, table, body, rawWriter(reply))
    reply.raw.end()
    ctx.audit.log({
      actor: actor(req),
      action: 'data.export',
      target: `${schema}.${table}`,
      connectionId: connId,
      database: db,
      details: `${rows} row(s) as ${body.format}`,
      ip: req.ip,
    })
    return reply
  })

  app.post(`${base}/import`, { preHandler: requireRole('editor') }, async (req) => {
    const { connId, db, schema, table } = req.params as TableParams
    connections.assertWritable(connId)
    const file = await req.file({ limits: { fileSize: 100 * 1024 * 1024 } })
    if (!file) throw new BadRequestError('No file uploaded')
    const fields = file.fields as Record<string, { value?: string } | undefined>
    const rawDelimiter = fields.delimiter?.value ?? ','
    const delimiter = rawDelimiter === '\\t' ? '\t' : rawDelimiter
    const content = (await file.toBuffer()).toString('utf8')
    const inserted = await data.importCsv(connId, db, schema, table, content, delimiter)
    ctx.audit.log({
      actor: actor(req),
      action: 'data.import',
      target: `${schema}.${table}`,
      connectionId: connId,
      database: db,
      details: `${inserted} row(s) from ${file.filename}`,
      ip: req.ip,
    })
    return { inserted }
  })
}
