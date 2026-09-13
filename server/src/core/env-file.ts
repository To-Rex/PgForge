import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Minimal `.env` reader/writer for settings the operator can change from the
 * UI. It is deliberately line-oriented: comments, ordering and unrelated keys
 * are preserved exactly, because this file is usually hand-maintained.
 *
 * Writing here only helps where the file itself survives a redeploy — a bare
 * VPS checkout, or a mounted volume. In an image-based deploy the platform's
 * own environment editor is the durable place, which is why every save also
 * hands the caller the literal line to paste there.
 */

/** The locations the server looks in at startup, in order. */
const CANDIDATES = ['.env', '../.env'] as const

/**
 * Every `.env` the server could load, in search order.
 *
 * Startup stops at the first file that exists, so only one of these ever
 * supplies values — but which one depends on what is present on disk. Writing
 * a setting to all of them keeps them from disagreeing, whichever wins.
 *
 * When none exist yet, the single default location is returned so a save can
 * create it.
 */
export function resolveEnvFiles(cwd: string = process.cwd()): string[] {
  const existing = CANDIDATES.map((candidate) => path.resolve(cwd, candidate)).filter((file) =>
    existsSync(file),
  )
  return existing.length > 0 ? existing : [path.resolve(cwd, '.env')]
}

/**
 * The one file startup will actually read — the first that exists, or the
 * default location. Use this to decide what the next boot will see; use
 * `resolveEnvFiles` to decide where to write.
 */
export function resolveEnvFile(cwd: string = process.cwd()): string {
  return resolveEnvFiles(cwd)[0]!
}

export function isEnvWritable(file: string): boolean {
  try {
    if (existsSync(file)) {
      accessSync(file, constants.W_OK)
      return true
    }
    accessSync(path.dirname(file), constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** A value is quoted only when it needs to be, to keep the file readable. */
export function formatEnvValue(value: string): string {
  if (value.length === 0) return ''
  if (/^[A-Za-z0-9_./:@%+,=?&~^-]+$/.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function envLine(key: string, value: string): string {
  return `${key}=${formatEnvValue(value)}`
}

/** Strips surrounding quotes and inline whitespace the way dotenv does. */
function parseValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
    const quote = trimmed[0]!
    if (trimmed.endsWith(quote)) {
      const inner = trimmed.slice(1, -1)
      return quote === '"' ? inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\') : inner
    }
  }
  return trimmed
}

/** Reads one key without touching process.env. Returns null when absent. */
export function readEnvVar(file: string, key: string): string | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split(/\r?\n/)) {
    const withoutExport = line.replace(/^\s*export\s+/, '')
    if (withoutExport.trimStart().startsWith('#')) continue
    const eq = withoutExport.indexOf('=')
    if (eq === -1) continue
    if (withoutExport.slice(0, eq).trim() !== key) continue
    return parseValue(withoutExport.slice(eq + 1))
  }
  return null
}

/**
 * Replaces the first assignment of `key`, or appends one. Commented-out
 * placeholders (`# METADATA_URL=`) are left alone and the real value appended,
 * so the example stays as documentation.
 */
export function upsertEnvVar(file: string, key: string, value: string): void {
  const line = envLine(key, value)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    /* creating a new file */
  }

  const lines = text.length > 0 ? text.split(/\r?\n/) : []
  // A file ending in a newline splits with a trailing empty element; drop it so
  // the final `\n` below does not become a blank line on every rewrite.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const index = lines.findIndex((entry) => {
    const withoutExport = entry.replace(/^\s*export\s+/, '')
    if (withoutExport.trimStart().startsWith('#')) return false
    const eq = withoutExport.indexOf('=')
    return eq !== -1 && withoutExport.slice(0, eq).trim() === key
  })

  if (index === -1) {
    // Blank separator line, so an appended setting does not crowd the previous
    // block — but never as the first line of a brand-new file.
    if (lines.length > 0) lines.push('')
    lines.push(line)
  } else {
    lines[index] = line
  }

  // 0600: the DSN carries a password.
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
}

/** Removes every assignment of `key`. No-op when the file or key is absent. */
export function removeEnvVar(file: string, key: string): void {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const kept = text.split(/\r?\n/).filter((entry) => {
    const withoutExport = entry.replace(/^\s*export\s+/, '')
    if (withoutExport.trimStart().startsWith('#')) return true
    const eq = withoutExport.indexOf('=')
    return !(eq !== -1 && withoutExport.slice(0, eq).trim() === key)
  })
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  writeFileSync(file, kept.length > 0 ? `${kept.join('\n')}\n` : '', { mode: 0o600 })
}

/**
 * Hides the password in a PostgreSQL DSN so status responses and logs can show
 * which server is configured without leaking the credential. Unparseable input
 * is reduced to a constant rather than echoed back.
 */
export function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '(unparseable connection string)'
  }
}
