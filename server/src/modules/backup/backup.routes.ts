import { createReadStream } from 'node:fs'
import type { BackupSchedule } from '@pgforge/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { BadRequestError, NotFoundError } from '../../core/errors.js'
import { newId, nowIso } from '../../core/util.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { ConnectionsService } from '../connections/connections.service.js'
import type { BackupRepo } from './backup.repo.js'
import type { BackupService } from './backup.service.js'
import { nextRun, nextRuns, validateCron, type BackupScheduler } from './scheduler.js'

const backupRequestSchema = z.object({
  connectionId: z.string().uuid(),
  database: z.string().min(1).max(128),
  format: z.enum(['custom', 'plain', 'tar']),
  schemas: z.array(z.string().min(1)).max(100).optional(),
  tables: z.array(z.string().min(1)).max(500).optional(),
  schemaOnly: z.boolean().optional(),
  dataOnly: z.boolean().optional(),
})

const restoreSchema = z.object({
  connectionId: z.string().uuid(),
  database: z.string().min(1).max(128),
  clean: z.boolean().optional(),
  create: z.boolean().optional(),
})

const migrationSchema = z.object({
  sourceConnectionId: z.string().uuid(),
  sourceDatabase: z.string().min(1).max(128),
  targetConnectionId: z.string().uuid(),
  targetDatabase: z.string().min(1).max(128),
  createDatabase: z.boolean().optional(),
})

const scheduleInputSchema = z.object({
  name: z.string().min(1).max(100),
  connectionId: z.string().uuid(),
  database: z.string().min(1).max(128),
  cron: z.string().min(9).max(100),
  format: z.enum(['custom', 'plain', 'tar']),
  retention: z.number().int().min(1).max(365),
  enabled: z.boolean(),
})

const listQuerySchema = z.object({ connectionId: z.string().uuid().optional() })

export function registerBackupRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  service: BackupService,
  repo: BackupRepo,
  scheduler: BackupScheduler,
  connections: ConnectionsService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  const withNextRun = (s: BackupSchedule): BackupSchedule => ({
    ...s,
    nextRunAt: s.enabled ? nextRun(s.cron) : null,
  })

  app.get('/api/backups', async (req) => {
    const query = parse(listQuerySchema, req.query)
    return service.list(query.connectionId)
  })

  app.post('/api/backups', { preHandler: requireRole('editor') }, async (req) => {
    const body = parse(backupRequestSchema, req.body)
    const record = await service.createBackup(body, 'manual')
    ctx.audit.log({
      actor: actor(req),
      action: 'backup.create',
      target: record.fileName,
      connectionId: body.connectionId,
      database: body.database,
      details: `format=${body.format}`,
      ip: req.ip,
    })
    return record
  })

  app.get('/api/backups/:id', async (req) => {
    const { id } = req.params as { id: string }
    return service.byId(id)
  })

  app.get('/api/backups/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string }
    const record = service.byId(id)
    if (record.status !== 'success') throw new BadRequestError('Backup is not downloadable')
    ctx.audit.log({
      actor: actor(req),
      action: 'backup.download',
      target: record.fileName,
      connectionId: record.connectionId,
      database: record.database,
      ip: req.ip,
    })
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${record.fileName}"`)
      .send(createReadStream(service.filePath(record)))
  })

  app.delete('/api/backups/:id', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const record = service.byId(id)
    await service.deleteBackup(id)
    ctx.audit.log({
      actor: actor(req),
      action: 'backup.delete',
      target: record.fileName,
      connectionId: record.connectionId,
      ip: req.ip,
    })
    return { ok: true }
  })

  app.post('/api/backups/:id/restore', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const body = parse(restoreSchema, req.body)
    connections.assertWritable(body.connectionId)
    const jobId = await service.restoreBackup(id, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'backup.restore',
      target: service.byId(id).fileName,
      connectionId: body.connectionId,
      database: body.database,
      details: `clean=${body.clean ?? false} create=${body.create ?? false}`,
      ip: req.ip,
    })
    return { jobId }
  })

  app.get('/api/backups/:id/inspect', async (req) => {
    const { id } = req.params as { id: string }
    service.byId(id)
    return service.getInspection(id)
  })

  app.post('/api/backups/:id/inspect', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const backup = service.byId(id)
    connections.assertWritable(backup.connectionId)
    const inspection = await service.startInspection(id)
    ctx.audit.log({
      actor: actor(req),
      action: 'backup.inspect',
      target: backup.fileName,
      connectionId: backup.connectionId,
      database: inspection.database ?? undefined,
      ip: req.ip,
    })
    return inspection
  })

  app.delete('/api/backups/:id/inspect', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const backup = service.byId(id)
    const inspection = service.getInspection(id)
    await service.closeInspection(id)
    ctx.audit.log({
      actor: actor(req),
      action: 'backup.inspect.close',
      target: backup.fileName,
      connectionId: backup.connectionId,
      database: inspection.database ?? undefined,
      ip: req.ip,
    })
    return { ok: true }
  })

  app.post('/api/restore/upload', { preHandler: requireRole('editor') }, async (req) => {
    const file = await req.file({ limits: { fileSize: 2 * 1024 * 1024 * 1024 } })
    if (!file) throw new BadRequestError('No file uploaded')
    const fields = file.fields as Record<string, { value?: string } | undefined>
    const body = parse(restoreSchema, {
      connectionId: fields.connectionId?.value,
      database: fields.database?.value,
      clean: fields.clean?.value === 'true',
      create: fields.create?.value === 'true',
    })
    connections.assertWritable(body.connectionId)
    const content = await file.toBuffer()
    const jobId = await service.restoreUpload(file.filename, content, body)
    ctx.audit.log({
      actor: actor(req),
      action: 'restore.upload',
      target: file.filename,
      connectionId: body.connectionId,
      database: body.database,
      ip: req.ip,
    })
    return { jobId }
  })

  app.post('/api/migrations', { preHandler: requireRole('editor') }, async (req) => {
    const body = parse(migrationSchema, req.body)
    connections.assertWritable(body.targetConnectionId)
    const jobId = await service.migrate(body)
    ctx.audit.log({
      actor: actor(req),
      action: 'database.migrate',
      target: `${body.sourceDatabase} → ${body.targetDatabase}`,
      connectionId: body.sourceConnectionId,
      database: body.sourceDatabase,
      ip: req.ip,
    })
    return { jobId }
  })

  app.get('/api/jobs/:id', async (req) => {
    const { id } = req.params as { id: string }
    const job = ctx.jobs.get(id)
    if (!job) throw new NotFoundError('Job not found')
    return job
  })

  app.post('/api/jobs/:id/cancel', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const canceled = ctx.jobs.cancel(id)
    if (canceled) {
      ctx.audit.log({ actor: actor(req), action: 'job.cancel', target: id, ip: req.ip })
    }
    return { canceled }
  })

  app.get('/api/backup-schedules', async () => repo.listSchedules().map(withNextRun))

  app.post('/api/backup-schedules/preview', async (req) => {
    const body = parse(z.object({ cron: z.string().min(5).max(100) }), req.body)
    const runs = nextRuns(body.cron, 3)
    return { valid: runs !== null && runs.length > 0, nextRuns: runs ?? [] }
  })

  app.post('/api/backup-schedules', { preHandler: requireRole('editor') }, async (req) => {
    const body = parse(scheduleInputSchema, req.body)
    validateCron(body.cron)
    connections.assertWritable(body.connectionId)
    const schedule: BackupSchedule = {
      id: newId(),
      ...body,
      connectionName: null,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: nowIso(),
    }
    repo.insertSchedule(schedule)
    scheduler.sync(schedule)
    ctx.audit.log({
      actor: actor(req),
      action: 'schedule.create',
      target: body.name,
      connectionId: body.connectionId,
      database: body.database,
      details: body.cron,
      ip: req.ip,
    })
    return withNextRun(repo.scheduleById(schedule.id)!)
  })

  app.put('/api/backup-schedules/:id', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const existing = repo.scheduleById(id)
    if (!existing) throw new NotFoundError('Schedule not found')
    const body = parse(scheduleInputSchema, req.body)
    validateCron(body.cron)
    const updated: BackupSchedule = { ...existing, ...body }
    repo.updateSchedule(updated)
    scheduler.sync(updated)
    ctx.audit.log({
      actor: actor(req),
      action: 'schedule.update',
      target: body.name,
      connectionId: body.connectionId,
      ip: req.ip,
    })
    return withNextRun(repo.scheduleById(id)!)
  })

  app.delete('/api/backup-schedules/:id', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const existing = repo.scheduleById(id)
    if (!existing) throw new NotFoundError('Schedule not found')
    repo.deleteSchedule(id)
    scheduler.remove(id)
    ctx.audit.log({ actor: actor(req), action: 'schedule.delete', target: existing.name, ip: req.ip })
    return { ok: true }
  })

  app.post('/api/backup-schedules/:id/run', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    if (!repo.scheduleById(id)) throw new NotFoundError('Schedule not found')
    await scheduler.runNow(id)
    return { ok: true }
  })
}
