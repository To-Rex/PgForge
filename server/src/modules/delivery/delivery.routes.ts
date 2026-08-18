import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { DeliveryService } from './delivery.service.js'

const settingsSchema = z.object({
  telegram: z.object({
    enabled: z.boolean(),
    botToken: z.string().max(200).optional(),
    chatId: z.string().max(100),
  }),
  email: z.object({
    enabled: z.boolean(),
    host: z.string().max(255),
    port: z.number().int().min(1).max(65535),
    security: z.enum(['ssl', 'starttls', 'none']),
    username: z.string().max(255),
    password: z.string().max(500).optional(),
    from: z.string().max(255),
    to: z.string().max(1000),
  }),
  yandex: z.object({
    enabled: z.boolean(),
    token: z.string().max(500).optional(),
    folder: z.string().max(200),
  }),
  autoSend: z.boolean(),
})

const testSchema = z.object({ channel: z.enum(['telegram', 'email', 'yandex']) })

const sendSchema = z.object({
  channels: z.array(z.enum(['telegram', 'email', 'yandex'])).min(1).max(3),
})

export function registerDeliveryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  delivery: DeliveryService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.get('/api/delivery/settings', { preHandler: requireRole('admin') }, async () =>
    delivery.getSettings(),
  )

  // Which channels a backup can be sent to — safe metadata for any user.
  app.get('/api/delivery/channels', async () => ({ channels: delivery.enabledChannels() }))

  // Live bot identity so admins can see the token actually connected.
  app.get('/api/delivery/telegram-info', { preHandler: requireRole('admin') }, async () =>
    delivery.telegramBotInfo(),
  )

  app.put('/api/delivery/settings', { preHandler: requireRole('admin') }, async (req) => {
    const body = parse(settingsSchema, req.body)
    const saved = delivery.saveSettings(body)
    ctx.audit.log({
      actor: actor(req),
      action: 'delivery.settings.update',
      details: `telegram=${saved.telegram.enabled} email=${saved.email.enabled} yandex=${saved.yandex.enabled} autoSend=${saved.autoSend}`,
      ip: req.ip,
    })
    return saved
  })

  app.post('/api/delivery/test', { preHandler: requireRole('admin') }, async (req) => {
    const body = parse(testSchema, req.body)
    const result = await delivery.test(body.channel)
    ctx.audit.log({
      actor: actor(req),
      action: 'delivery.test',
      target: body.channel,
      status: result.ok ? 'ok' : 'error',
      details: result.error,
      ip: req.ip,
    })
    return result
  })

  app.post('/api/backups/:id/send', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = req.params as { id: string }
    const body = parse(sendSchema, req.body)
    const jobId = await delivery.sendBackup(id, body.channels)
    ctx.audit.log({
      actor: actor(req),
      action: 'delivery.send',
      target: id,
      details: `channels: ${body.channels.join(', ')} · job ${jobId}`,
      ip: req.ip,
    })
    return { jobId }
  })
}
