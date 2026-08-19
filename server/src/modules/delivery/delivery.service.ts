import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import nodemailer from 'nodemailer'
import type {
  BackupRecord,
  DeliveryChannel,
  DeliverySettings,
  DeliveryTestResult,
  EmailSettings,
  SmtpSecurity,
  TelegramSettings,
  YandexSettings,
} from '@pgforge/shared'
import { BadRequestError } from '../../core/errors.js'
import { decryptSecret, encryptSecret } from '../../core/crypto.js'
import { formatBytesForLog } from './format-bytes.js'
import { extractTelegramChatIds } from './telegram.js'
import type { AppContext } from '../../context.js'
import type { BackupService } from '../backup/backup.service.js'

/** Telegram Bot API rejects documents over 50 MB. */
const TELEGRAM_MAX_BYTES = 50 * 1024 * 1024
const YANDEX_API = 'https://cloud-api.yandex.net/v1/disk'
const API_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 15 * 60_000

interface StoredTelegram {
  enabled: boolean
  botTokenEnc: string | null
  chatId: string
}

interface StoredEmail {
  enabled: boolean
  host: string
  port: number
  security: SmtpSecurity
  username: string
  passwordEnc: string | null
  from: string
  to: string
}

interface StoredYandex {
  enabled: boolean
  tokenEnc: string | null
  folder: string
}

const DEFAULT_TELEGRAM: StoredTelegram = { enabled: false, botTokenEnc: null, chatId: '' }
const DEFAULT_EMAIL: StoredEmail = {
  enabled: false,
  host: '',
  port: 587,
  security: 'starttls',
  username: '',
  passwordEnc: null,
  from: '',
  to: '',
}
const DEFAULT_YANDEX: StoredYandex = { enabled: false, tokenEnc: null, folder: 'PgForge' }

export class DeliveryService {
  constructor(
    private readonly ctx: AppContext,
    private readonly backups: BackupService,
  ) {}

  // ── Settings ────────────────────────────────────────────────────────────

  private readKey<T>(key: string, fallback: T): T {
    const row = this.ctx.store.get<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = :key',
      { key },
    )
    if (!row) return fallback
    try {
      return { ...fallback, ...(JSON.parse(row.value) as T) }
    } catch {
      return fallback
    }
  }

  private hasKey(key: string): boolean {
    return (
      this.ctx.store.get<{ value: string }>('SELECT value FROM app_settings WHERE key = :key', {
        key,
      }) !== undefined
    )
  }

  /**
   * First-run defaults (mirrors MXVault), used until the admin saves the
   * form. Priority: SMTP_* environment variables (a complete, working
   * default — including the password, kept in .env, never in code); falling
   * back to Gmail settings pre-filled with the first administrator's address.
   */
  private emailDefaults(): StoredEmail {
    const env = this.ctx.config.smtp
    if (env) {
      return {
        enabled: Boolean(env.host && env.from && env.to),
        host: env.host,
        port: env.port,
        security: env.security,
        username: env.username,
        passwordEnc: env.password
          ? encryptSecret(env.password, this.ctx.config.credentialKey)
          : null,
        from: env.from,
        to: env.to,
      }
    }
    const admin = this.ctx.store.get<{ email: string }>(
      "SELECT email FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1",
    )
    return {
      ...DEFAULT_EMAIL,
      host: 'smtp.gmail.com',
      port: 587,
      security: 'starttls',
      username: admin?.email ?? '',
      from: admin?.email ?? '',
      to: admin?.email ?? '',
    }
  }

  /** Saved settings when present, otherwise the live defaults. */
  private storedOrDefaultEmail(): StoredEmail {
    if (this.hasKey('delivery.email')) {
      const stored = this.readKey('delivery.email', DEFAULT_EMAIL)
      // A blank saved config (written as a side effect of saving another
      // channel's settings) must not shadow the environment defaults.
      if (stored.host) return stored
    }
    return this.emailDefaults()
  }

  private writeKey(key: string, value: unknown): void {
    this.ctx.store.run(
      `INSERT INTO app_settings (key, value) VALUES (:key, :value)
       ON CONFLICT (key) DO UPDATE SET value = :value`,
      { key, value: JSON.stringify(value) },
    )
  }

  getSettings(): DeliverySettings {
    const telegram = this.readKey('delivery.telegram', DEFAULT_TELEGRAM)
    const email = this.storedOrDefaultEmail()
    const yandex = this.readKey('delivery.yandex', DEFAULT_YANDEX)
    const autoSend = this.readKey('delivery.autoSend', { enabled: false })
    return {
      telegram: {
        enabled: telegram.enabled,
        botTokenSet: telegram.botTokenEnc !== null,
        chatId: telegram.chatId,
      },
      email: {
        enabled: email.enabled,
        host: email.host,
        port: email.port,
        security: email.security,
        username: email.username,
        passwordSet: email.passwordEnc !== null,
        from: email.from,
        to: email.to,
      },
      yandex: {
        enabled: yandex.enabled,
        tokenSet: yandex.tokenEnc !== null,
        folder: yandex.folder,
      },
      autoSend: autoSend.enabled,
    }
  }

  saveSettings(input: {
    telegram: Pick<TelegramSettings, 'enabled' | 'botToken' | 'chatId'>
    email: Pick<EmailSettings, 'enabled' | 'host' | 'port' | 'security' | 'username' | 'password' | 'from' | 'to'>
    yandex: Pick<YandexSettings, 'enabled' | 'token' | 'folder'>
    autoSend: boolean
  }): DeliverySettings {
    const key = this.ctx.config.credentialKey
    const prevTelegram = this.readKey('delivery.telegram', DEFAULT_TELEGRAM)
    // Includes env-derived defaults so the first save (with an empty password
    // field) keeps the .env password instead of silently dropping it.
    const prevEmail = this.storedOrDefaultEmail()
    const prevYandex = this.readKey('delivery.yandex', DEFAULT_YANDEX)

    this.writeKey('delivery.telegram', {
      enabled: input.telegram.enabled,
      chatId: input.telegram.chatId.trim(),
      botTokenEnc: input.telegram.botToken?.trim()
        ? encryptSecret(input.telegram.botToken.trim(), key)
        : prevTelegram.botTokenEnc,
    } satisfies StoredTelegram)

    this.writeKey('delivery.email', {
      enabled: input.email.enabled,
      host: input.email.host.trim(),
      port: input.email.port,
      security: input.email.security,
      username: input.email.username.trim(),
      from: input.email.from.trim(),
      to: input.email.to.trim(),
      passwordEnc: input.email.password ? encryptSecret(input.email.password, key) : prevEmail.passwordEnc,
    } satisfies StoredEmail)

    this.writeKey('delivery.yandex', {
      enabled: input.yandex.enabled,
      folder: input.yandex.folder.trim().replaceAll(/^\/+|\/+$/g, '') || 'PgForge',
      tokenEnc: input.yandex.token?.trim()
        ? encryptSecret(input.yandex.token.trim(), key)
        : prevYandex.tokenEnc,
    } satisfies StoredYandex)

    this.writeKey('delivery.autoSend', { enabled: input.autoSend })
    return this.getSettings()
  }

  /** Channels that are both switched on and fully configured. */
  enabledChannels(): DeliveryChannel[] {
    const telegram = this.readKey('delivery.telegram', DEFAULT_TELEGRAM)
    const email = this.storedOrDefaultEmail()
    const yandex = this.readKey('delivery.yandex', DEFAULT_YANDEX)
    const channels: DeliveryChannel[] = []
    // No chat id needed: without one, delivery broadcasts to every chat
    // that has messaged the bot.
    if (telegram.enabled && telegram.botTokenEnc) channels.push('telegram')
    if (email.enabled && email.host && email.from && email.to) channels.push('email')
    if (yandex.enabled && yandex.tokenEnc) channels.push('yandex')
    return channels
  }

  // ── Channel transports ──────────────────────────────────────────────────

  private telegramToken(): { token: string; chatId: string } {
    const cfg = this.readKey('delivery.telegram', DEFAULT_TELEGRAM)
    if (!cfg.botTokenEnc) throw new BadRequestError('Telegram is not configured')
    return { token: decryptSecret(cfg.botTokenEnc, this.ctx.config.credentialKey), chatId: cfg.chatId }
  }

  /** Explicit chat id, or broadcast targets discovered via getUpdates. */
  private async telegramChatIds(token: string, chatId: string): Promise<string[]> {
    if (chatId.trim()) return [chatId.trim()]
    const json = (await this.telegramCall(token, 'getUpdates', { limit: 100 })) as {
      result?: unknown
    }
    const ids = extractTelegramChatIds(json.result)
    if (ids.length === 0) {
      throw new Error(
        'Broadcast: no chats found. Ask recipients to send /start to the bot, or set an explicit Chat ID.',
      )
    }
    return ids
  }

  async telegramBotInfo(): Promise<{ ok: boolean; username?: string; error?: string }> {
    try {
      const { token } = this.telegramToken()
      const me = (await this.telegramCall(token, 'getMe', {})) as {
        result?: { username?: string }
      }
      return { ok: true, username: me.result?.username }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async telegramCall(token: string, method: string, body: FormData | object): Promise<unknown> {
    const isForm = body instanceof FormData
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(isForm ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
    if (!res.ok || !json?.ok) {
      throw new Error(json?.description ?? `Telegram API error (HTTP ${res.status})`)
    }
    return json
  }

  private async sendTelegram(backup: BackupRecord, filePath: string, sizeBytes: number): Promise<string> {
    const { token, chatId } = this.telegramToken()
    if (sizeBytes > TELEGRAM_MAX_BYTES) {
      throw new Error(
        `File is ${formatBytesForLog(sizeBytes)} — Telegram bots can send at most 50 MB. Use Yandex Disk or email for this backup.`,
      )
    }
    const chatIds = await this.telegramChatIds(token, chatId)
    const content = new Blob([await readFile(filePath)])
    const caption = `PgForge backup\n${backup.database} · ${backup.format} · ${formatBytesForLog(sizeBytes)}\n${backup.createdAt}`
    let sent = 0
    const errors: string[] = []
    for (const id of chatIds) {
      const form = new FormData()
      form.append('chat_id', id)
      form.append('caption', caption)
      form.append('document', content, backup.fileName)
      try {
        await this.telegramCall(token, 'sendDocument', form)
        sent++
      } catch (err) {
        errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (sent === 0) throw new Error(errors.join('; ') || 'No chats reachable')
    return `sent to ${sent}/${chatIds.length} chat(s)${errors.length ? ` (failed: ${errors.join('; ')})` : ''}`
  }

  private emailTransport(): { transport: nodemailer.Transporter; cfg: StoredEmail } {
    const cfg = this.storedOrDefaultEmail()
    if (!cfg.host || !cfg.from || !cfg.to) throw new BadRequestError('Email is not configured')
    const password = cfg.passwordEnc
      ? decryptSecret(cfg.passwordEnc, this.ctx.config.credentialKey)
      : undefined
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.security === 'ssl',
      requireTLS: cfg.security === 'starttls',
      ignoreTLS: cfg.security === 'none',
      auth: cfg.username ? { user: cfg.username, pass: password ?? '' } : undefined,
      connectionTimeout: 20_000,
    })
    return { transport, cfg }
  }

  private async sendEmail(backup: BackupRecord, filePath: string, sizeBytes: number): Promise<string> {
    const { transport, cfg } = this.emailTransport()
    await transport.sendMail({
      from: cfg.from,
      to: cfg.to,
      subject: `PgForge backup — ${backup.database} (${backup.createdAt.slice(0, 10)})`,
      text: [
        'PgForge database backup',
        '',
        `Database:  ${backup.database}`,
        `Format:    ${backup.format}`,
        `Size:      ${formatBytesForLog(sizeBytes)}`,
        `Created:   ${backup.createdAt}`,
        `File:      ${backup.fileName}`,
      ].join('\n'),
      attachments: [{ filename: backup.fileName, path: filePath }],
    })
    return `sent to ${cfg.to}`
  }

  private yandexToken(): { token: string; folder: string } {
    const cfg = this.readKey('delivery.yandex', DEFAULT_YANDEX)
    if (!cfg.tokenEnc) throw new BadRequestError('Yandex Disk is not configured')
    return { token: decryptSecret(cfg.tokenEnc, this.ctx.config.credentialKey), folder: cfg.folder }
  }

  private async sendYandex(backup: BackupRecord, filePath: string): Promise<string> {
    const { token, folder } = this.yandexToken()
    const headers = { authorization: `OAuth ${token}` }

    // Ensure the target folder exists (409 = already there).
    const mkdir = await fetch(
      `${YANDEX_API}/resources?path=${encodeURIComponent(`disk:/${folder}`)}`,
      { method: 'PUT', headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    )
    if (!mkdir.ok && mkdir.status !== 409) {
      throw new Error(`Yandex Disk: cannot create folder (HTTP ${mkdir.status})`)
    }

    const diskPath = `disk:/${folder}/${backup.fileName}`
    const uploadRes = await fetch(
      `${YANDEX_API}/resources/upload?path=${encodeURIComponent(diskPath)}&overwrite=true`,
      { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    )
    const uploadJson = (await uploadRes.json().catch(() => null)) as
      | { href?: string; message?: string }
      | null
    if (!uploadRes.ok || !uploadJson?.href) {
      throw new Error(uploadJson?.message ?? `Yandex Disk: upload URL request failed (HTTP ${uploadRes.status})`)
    }

    const put = await fetch(uploadJson.href, {
      method: 'PUT',
      body: Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>,
      // Node fetch requires half-duplex for streamed request bodies.
      duplex: 'half',
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    } as RequestInit)
    if (!put.ok) throw new Error(`Yandex Disk: upload failed (HTTP ${put.status})`)
    return `uploaded to ${diskPath}`
  }

  /** True when an SMTP transport can be built (stored settings or env defaults). */
  emailConfigured(): boolean {
    const cfg = this.storedOrDefaultEmail()
    return Boolean(cfg.host && cfg.from)
  }

  /** Generic transactional mail (invitations etc.) through the configured SMTP. */
  async sendMail(to: string, subject: string, text: string): Promise<void> {
    const cfg = this.storedOrDefaultEmail()
    if (!cfg.host || !cfg.from) throw new BadRequestError('Email is not configured')
    const password = cfg.passwordEnc
      ? decryptSecret(cfg.passwordEnc, this.ctx.config.credentialKey)
      : undefined
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.security === 'ssl',
      requireTLS: cfg.security === 'starttls',
      ignoreTLS: cfg.security === 'none',
      auth: cfg.username ? { user: cfg.username, pass: password ?? '' } : undefined,
      connectionTimeout: 20_000,
    })
    await transport.sendMail({ from: cfg.from, to, subject, text })
  }

  // ── Test, send, auto-send ───────────────────────────────────────────────

  async test(channel: DeliveryChannel): Promise<DeliveryTestResult> {
    try {
      if (channel === 'telegram') {
        const { token, chatId } = this.telegramToken()
        const me = (await this.telegramCall(token, 'getMe', {})) as {
          result?: { username?: string }
        }
        const chatIds = await this.telegramChatIds(token, chatId)
        for (const id of chatIds) {
          await this.telegramCall(token, 'sendMessage', {
            chat_id: id,
            text: '✅ PgForge: Telegram delivery is configured correctly.',
          })
        }
        return {
          ok: true,
          detail: `@${me.result?.username ?? 'bot'} → ${chatIds.length} chat(s)`,
        }
      } else if (channel === 'email') {
        const { transport, cfg } = this.emailTransport()
        await transport.sendMail({
          from: cfg.from,
          to: cfg.to,
          subject: 'PgForge — test message',
          text: 'Email delivery is configured correctly.',
        })
      } else {
        const { token } = this.yandexToken()
        const res = await fetch(YANDEX_API, {
          headers: { authorization: `OAuth ${token}` },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        })
        if (!res.ok) throw new Error(`Yandex Disk API responded with HTTP ${res.status}`)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Starts an async delivery job; per-channel progress lands in the job log. */
  async sendBackup(backupId: string, channels: DeliveryChannel[]): Promise<string> {
    const backup = this.backups.byId(backupId)
    if (backup.status !== 'success') throw new BadRequestError('Backup is not sendable')
    const filePath = this.backups.filePath(backup)
    const info = await stat(filePath).catch(() => {
      throw new BadRequestError('Backup file is missing from disk')
    })
    const jobId = this.ctx.jobs.create('delivery', backup.connectionId, backup.database)
    void this.runDelivery(jobId, backup, filePath, info.size, channels)
    return jobId
  }

  private async runDelivery(
    jobId: string,
    backup: BackupRecord,
    filePath: string,
    sizeBytes: number,
    channels: DeliveryChannel[],
  ): Promise<void> {
    const failures: string[] = []
    this.ctx.jobs.appendLog(jobId, `Delivering ${backup.fileName} (${formatBytesForLog(sizeBytes)})`)
    for (const channel of channels) {
      this.ctx.jobs.appendLog(jobId, `→ ${channel}: sending…`)
      try {
        const detail =
          channel === 'telegram'
            ? await this.sendTelegram(backup, filePath, sizeBytes)
            : channel === 'email'
              ? await this.sendEmail(backup, filePath, sizeBytes)
              : await this.sendYandex(backup, filePath)
        this.ctx.jobs.appendLog(jobId, `✓ ${channel}: ${detail}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failures.push(channel)
        this.ctx.jobs.appendLog(jobId, `✗ ${channel}: ${message}`)
      }
    }
    this.ctx.jobs.finish(
      jobId,
      failures.length === 0 ? 'success' : 'failed',
      failures.length > 0 ? `Failed channels: ${failures.join(', ')}` : undefined,
    )
  }

  /** Called after a scheduled backup completes when auto-send is on. */
  autoSend(backupId: string): void {
    const autoSend = this.readKey('delivery.autoSend', { enabled: false })
    if (!autoSend.enabled) return
    const channels = this.enabledChannels()
    if (channels.length === 0) return
    this.sendBackup(backupId, channels)
      .then((jobId) => {
        this.ctx.audit.log({
          actor: null,
          action: 'delivery.auto',
          target: this.backups.byId(backupId).fileName,
          details: `channels: ${channels.join(', ')} · job ${jobId}`,
        })
      })
      .catch((err: unknown) => {
        this.ctx.audit.log({
          actor: null,
          action: 'delivery.auto',
          target: backupId,
          details: err instanceof Error ? err.message : 'failed to start',
          status: 'error',
        })
      })
  }
}
