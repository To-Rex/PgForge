import type { FieldMeta } from './data.js'

export interface SqlRequest {
  sql: string
  /** Client-generated id enabling cancellation. */
  execId: string
  maxRows?: number
  timeoutMs?: number
}

export interface StatementResult {
  command: string
  rowCount: number | null
  fields: FieldMeta[]
  rows: unknown[][]
  durationMs: number
  truncated: boolean
}

export interface SqlErrorInfo {
  message: string
  code?: string
  detail?: string
  hint?: string
  /** 1-based character offset into the submitted SQL. */
  position?: number
}

export interface SqlResponse {
  ok: boolean
  results: StatementResult[]
  error?: SqlErrorInfo
  notices: string[]
  totalDurationMs: number
}

export interface ExplainRequest {
  sql: string
  analyze?: boolean
}

export interface ExplainResponse {
  /** EXPLAIN (FORMAT JSON) output — a single plan object. */
  plan: unknown
  durationMs: number
}

export interface QueryHistoryEntry {
  id: string
  connectionId: string
  database: string
  sql: string
  ok: boolean
  error: string | null
  durationMs: number
  rowCount: number | null
  executedAt: string
}
