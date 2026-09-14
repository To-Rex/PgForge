import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { NotFoundError } from '../../core/errors.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { ClusterBackupService } from './cluster.service.js'

const createSchema = z.object({
  connectionId: z.string().uuid(),
  databases: z.array(z.string().min(1).max(128)).max(500).optional(),
  includeGlobals: z.boolean().optional(),
})

const restoreSchema = z.object({
  connectionId: z.string().uuid(),
  databases: z.array(z.string().min(1).max(128)).max(500).optional(),
  restoreGlobals: z.boolean().optional(),
  createDatabases: z.boolean().optional(),
  clean: z.boolean().optional(),
})

const listSchema = z.object({ connectionId: z.string().uuid().optional() })

/**
 * Whole-server bundles. Deliberately a separate surface from /api/backups so
 * the per-database routes — and everything built on them: schedules,
 * inspection, delivery — keep their exact shape.
 */
export function registerClusterBackupRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  cluster: ClusterBackupService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.get('/api/cluster-backups', async (req) => {
    const query = parse(listSchema, req.query)
    return cluster.list(query.connectionId)
  })

  app.get('/api/cluster-backups/databases/:connId', async (req) => {
    const { connId } = req.params as { connId: string }
    return cluster.listDatabases(connId)
  })

  app.post('/api/cluster-backups', { preHandler: requireRole('editor') }, async (req) => {
    const body = parse(createSchema, req.body)
    const record = await cluster.createBackup(body)
    ctx.audit.log({
      actor: actor(req),
      action: 'cluster_backup.create',
      target: record.fileName,
      connectionId: body.connectionId,
      details: `${record.databases.length} databases`,
      ip: req.ip,
    })
    return record
  })

  app.get('/api/cluster-backups/:id', async (req) => {
    const { id } = req.params as { id: string }
    return cluster.byId(id)
  })

  app.get('/api/cluster-backups/:id/contents', async (req) => {
    const { id } = req.params as { id: string }
    return cluster.contents(id)
  })

  app.get('/api/cluster-backups/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string }
    const record = cluster.byId(id)
    const filePath = cluster.filePath(record)
    const info = await stat(filePath).catch(() => {
      throw new NotFoundError('Bundle file is missing from disk')
    })
    ctx.audit.log({
      actor: actor(req),
      action: 'cluster_backup.download',
      target: record.fileName,
      connectionId: record.connectionId,
      ip: req.ip,
    })
    void reply
      .header('content-type', 'application/x-tar')
      .header('content-length', String(info.size))
      .header('content-disposition', `attachment; filename="${record.fileName}"`)
    return reply.send(createReadStream(filePath))
  })

  app.post('/api/cluster-backups/:id/restore', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const body = parse(restoreSchema, req.body)
    const jobId = await cluster.restore(id, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'cluster_backup.restore',
      target: cluster.byId(id).fileName,
      connectionId: body.connectionId,
      details: body.databases?.length ? `${body.databases.length} databases` : 'all databases',
      ip: req.ip,
    })
    return { jobId }
  })

  app.delete('/api/cluster-backups/:id', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const record = cluster.byId(id)
    await cluster.deleteBackup(id)
    ctx.audit.log({
      actor: actor(req),
      action: 'cluster_backup.delete',
      target: record.fileName,
      connectionId: record.connectionId,
      ip: req.ip,
    })
    return { ok: true }
  })
}
