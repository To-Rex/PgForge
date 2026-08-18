export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'starts'
  | 'ends'
  | 'in'
  | 'is_null'
  | 'not_null'

export interface RowFilter {
  column: string
  op: FilterOp
  /** Unused for is_null / not_null. For `in`, comma-separated values. */
  value?: string
}

export interface RowSort {
  column: string
  dir: 'asc' | 'desc'
}

export interface RowsQuery {
  page: number
  pageSize: number
  filters?: RowFilter[]
  sorts?: RowSort[]
  /** Free-text search across text-like columns. */
  search?: string
}

export interface FieldMeta {
  name: string
  dataType: string
}

export interface RowsPage {
  columns: FieldMeta[]
  /** Row-major values; JSON-safe (dates/bytea serialized server-side). */
  rows: unknown[][]
  total: number
  totalIsEstimate: boolean
  primaryKey: string[]
  /** Rows are editable only when a primary key exists. */
  editable: boolean
  durationMs: number
}

/** Values keyed by column name. Nulls allowed; `undefined` means "omit". */
export type RowValues = Record<string, unknown>

export interface InsertRowRequest {
  values: RowValues
}

export interface UpdateRowRequest {
  /** Primary-key values identifying the row. */
  pk: RowValues
  changes: RowValues
}

export interface DeleteRowsRequest {
  pks: RowValues[]
}

export type ExportFormat = 'csv' | 'json'

export interface CsvImportResult {
  inserted: number
}

export interface TableExportRequest {
  format: ExportFormat
  filters?: RowFilter[]
  sorts?: RowSort[]
  /** Safety cap; server enforces its own maximum as well. */
  limit?: number
}
