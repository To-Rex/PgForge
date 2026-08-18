import { hkdfSync, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7070),
  HOST: z.string().default('0.0.0.0'),
  APP_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters — generate one with `openssl rand -base64 48`, or leave it unset to use an auto-generated persisted secret')
    .optional(),
  DATA_DIR: z.string().default('./data'),
  CORS_ORIGINS: z.string().default(''),
  SQL_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  SQL_MAX_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
  SQL_MAX_ROWS: z.coerce.number().int().min(100).default(5000),
  PG_DUMP_PATH: z.string().default('pg_dump'),
  PG_RESTORE_PATH: z.string().default('pg_restore'),
  PSQL_PATH: z.string().default('psql'),
})

export interface AppConfig {
  env: 'development' | 'production' | 'test'
  port: number
  host: string
  dataDir: string
  backupDir: string
  corsOrigins: string[]
  sql: { defaultTimeoutMs: number; maxTimeoutMs: number; maxRows: number }
  tools: { pgDump: string; pgRestore: string; psql: string }
  /** HKDF-derived from APP_SECRET; used to sign JWTs. */
  jwtSecret: string
  /** HKDF-derived from APP_SECRET; encrypts stored connection credentials. */
  credentialKey: Buffer
  /** Where the master secret came from. 'file' = auto-persisted in DATA_DIR. */
  secretSource: 'env' | 'file'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment configuration: ${issues}`)
  }
  const e = parsed.data

  const dataDir = path.resolve(e.DATA_DIR)

  // Without a stable secret, restarting the server would make every stored
  // connection credential unreadable. When APP_SECRET is not provided, a
  // generated secret is persisted next to the metadata store instead.
  let secret = e.APP_SECRET
  let secretSource: 'env' | 'file' = 'env'
  if (!secret) {
    const secretFile = path.join(dataDir, 'secret.key')
    secretSource = 'file'
    try {
      const existing = readFileSync(secretFile, 'utf8').trim()
      if (existing.length >= 32) secret = existing
    } catch {
      /* first run — generated below */
    }
    if (!secret) {
      secret = randomBytes(48).toString('base64')
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 })
    }
  }

  const derive = (info: string) =>
    Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), info, 32))
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    dataDir,
    backupDir: path.join(dataDir, 'backups'),
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    sql: {
      defaultTimeoutMs: e.SQL_DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: e.SQL_MAX_TIMEOUT_MS,
      maxRows: e.SQL_MAX_ROWS,
    },
    tools: { pgDump: e.PG_DUMP_PATH, pgRestore: e.PG_RESTORE_PATH, psql: e.PSQL_PATH },
    jwtSecret: derive('pgforge/jwt').toString('hex'),
    credentialKey: derive('pgforge/credentials'),
    secretSource,
  }
}
