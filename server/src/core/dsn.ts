import type { MetadataConnectionInput, MetadataConnectionParts, SslMode } from '@pgforge/shared'

const DEFAULT_PORT = 5432
const SSL_MODES: SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full']

/**
 * Assembling the DSN here — rather than asking the operator to hand-write one —
 * is what makes a password containing `@`, `:` or `/` a non-event. Every part
 * is percent-encoded exactly once, in one place, used by both the connection
 * attempt and the line written to `.env`.
 */
export function buildMetadataDsn(input: MetadataConnectionInput): string {
  const user = encodeURIComponent(input.username.trim())
  const auth = input.password.length > 0
    ? `${user}:${encodeURIComponent(input.password)}@`
    : user.length > 0
      ? `${user}@`
      : ''

  // A bare IPv6 literal needs brackets to be distinguishable from the port.
  const host = input.host.trim()
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host

  const port = Number.isFinite(input.port) && input.port > 0 ? input.port : DEFAULT_PORT
  const database = encodeURIComponent(input.database.trim())

  return `postgresql://${auth}${authority}:${port}/${database}?sslmode=${input.sslMode}`
}

/**
 * Splits a DSN back into fields so an existing setting can prefill the form.
 * The password is deliberately dropped: it is never returned to the browser,
 * so changing any other field means re-entering it.
 *
 * Returns null for anything that is not a PostgreSQL DSN, rather than throwing.
 */
export function parseMetadataDsn(url: string): MetadataConnectionParts | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return null

  // URL keeps the brackets on an IPv6 hostname; the form wants the bare address.
  const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname

  const rawMode = parsed.searchParams.get('sslmode')
  // Absent sslmode and `disable` behave identically at connection time, so the
  // form shows the one that actually describes what will happen.
  const sslMode = SSL_MODES.includes(rawMode as SslMode) ? (rawMode as SslMode) : 'disable'

  return {
    host: decodeURIComponent(hostname),
    port: parsed.port.length > 0 ? Number(parsed.port) : DEFAULT_PORT,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    username: decodeURIComponent(parsed.username),
    sslMode,
  }
}
