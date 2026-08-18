import { randomUUID } from 'node:crypto'

export const newId = (): string => randomUUID()

export const nowIso = (): string => new Date().toISOString()

/** JSON-safe serialization for values coming out of node-postgres. */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(toJsonSafe)
  return value
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
