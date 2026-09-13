/**
 * Heuristic index/maintenance findings derived from the statistics collector.
 * Advice, never automation: every finding carries the SQL it would run so the
 * operator applies it deliberately.
 */
export type AdviceKind =
  | 'unindexed_foreign_key'
  | 'seq_scan_heavy'
  | 'unused_index'
  | 'duplicate_index'
  | 'bloat'
  | 'never_analyzed'

export type AdviceSeverity = 'high' | 'medium' | 'low'

export interface AdviceItem {
  /** Stable within one response; used as a React key and for dismissal. */
  id: string
  kind: AdviceKind
  severity: AdviceSeverity
  schema: string
  /** Relation the finding is about; the index name for index-level findings. */
  table: string
  /** Columns involved, when the finding is column-specific. */
  columns: string[]
  /** Numbers behind the finding, rendered as `label: value` chips. */
  metrics: { label: string; value: string }[]
  /** Ready-to-run SQL. Empty when the fix is not a single statement. */
  sql: string
}

export interface AdviceResponse {
  items: AdviceItem[]
  /** False when pg_stat_user_tables has no samples yet (stats just reset). */
  hasStatistics: boolean
  generatedAt: string
}
