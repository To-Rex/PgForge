/** Object kinds the command palette can jump to. */
export type SearchKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'matview'
  | 'foreign'
  | 'sequence'
  | 'function'
  | 'procedure'
  | 'column'

export interface SearchHit {
  database: string
  /** Null for `database` hits. */
  schema: string | null
  name: string
  kind: SearchKind
  /** Owning relation for `column` hits; null otherwise. */
  table: string | null
  /** Higher is a better match; the server ranks, the client only orders. */
  score: number
}

export type SearchScope = 'database' | 'server'

export interface SearchResponse {
  hits: SearchHit[]
  /** Databases skipped — no CONNECT privilege, timeout, or the scan cap. */
  skipped: string[]
  /** True when the hit cap cut the result set short. */
  truncated: boolean
  durationMs: number
}
