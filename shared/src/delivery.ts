export type DeliveryChannel = 'telegram' | 'email' | 'yandex'

/** Secrets are write-only: GET returns only the *Set flags. */
export interface TelegramSettings {
  enabled: boolean
  /** Write-only bot token; empty on update keeps the stored one. */
  botToken?: string
  botTokenSet: boolean
  chatId: string
}

export type SmtpSecurity = 'ssl' | 'starttls' | 'none'

export interface EmailSettings {
  enabled: boolean
  host: string
  port: number
  security: SmtpSecurity
  username: string
  /** Write-only. */
  password?: string
  passwordSet: boolean
  from: string
  /** Comma-separated recipient list. */
  to: string
}

export interface YandexSettings {
  enabled: boolean
  /** Write-only OAuth token. */
  token?: string
  tokenSet: boolean
  /** Disk folder the backups are uploaded into. */
  folder: string
}

export interface DeliverySettings {
  telegram: TelegramSettings
  email: EmailSettings
  yandex: YandexSettings
  /** Send scheduled backups to every enabled channel automatically. */
  autoSend: boolean
}

export interface DeliveryTestResult {
  ok: boolean
  error?: string
  /** Human-readable success detail, e.g. "@MyBot → 3 chat(s)". */
  detail?: string
}

export interface TelegramBotInfo {
  ok: boolean
  username?: string
  error?: string
}

export interface SendBackupRequest {
  channels: DeliveryChannel[]
}
