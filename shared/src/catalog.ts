export interface DatabaseInfo {
  name: string
  owner: string
  encoding: string
  collation: string
  sizeBytes: number | null
  isTemplate: boolean
  connections: number
  comment: string | null
}

export interface CreateDatabaseInput {
  name: string
  owner?: string
  encoding?: string
  template?: string
}

export interface SchemaInfo {
  name: string
  owner: string
  tableCount: number
  sizeBytes: number
  comment: string | null
  /** pg_catalog / information_schema — shown in a collapsed group in the UI. */
  isSystem: boolean
}

export type RelKind = 'table' | 'view' | 'matview' | 'foreign'

export interface TableInfo {
  schema: string
  name: string
  kind: RelKind
  owner: string
  rowEstimate: number
  totalBytes: number
  comment: string | null
}

export interface ColumnInfo {
  name: string
  ordinal: number
  dataType: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
  isIdentity: boolean
  maxLength: number | null
  comment: string | null
}

export interface IndexInfo {
  name: string
  definition: string
  isUnique: boolean
  isPrimary: boolean
  sizeBytes: number
  scans: number
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
  onUpdate: string
  onDelete: string
}

export interface TriggerInfo {
  name: string
  timing: string
  events: string[]
  definition: string
  enabled: boolean
}

export interface CheckConstraintInfo {
  name: string
  definition: string
}

export interface TableStructure {
  schema: string
  name: string
  kind: RelKind
  columns: ColumnInfo[]
  primaryKey: string[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  /** Foreign keys in other tables that reference this table. */
  referencedBy: ForeignKeyInfo[]
  triggers: TriggerInfo[]
  checks: CheckConstraintInfo[]
  rowEstimate: number
  totalBytes: number
  /** Reconstructed CREATE statement (tables) or view definition. */
  ddl: string
  comment: string | null
}

export type RoutineKind = 'function' | 'procedure'

export interface RoutineInfo {
  schema: string
  name: string
  kind: RoutineKind
  language: string
  arguments: string
  returnType: string
  owner: string
  definition: string
  comment: string | null
}

export interface SequenceInfo {
  schema: string
  name: string
  dataType: string
  startValue: string
  minValue: string
  maxValue: string
  increment: string
  lastValue: string | null
}

/** One generic endpoint handles all guarded drops. */
export type DropKind =
  | 'table'
  | 'view'
  | 'matview'
  | 'index'
  | 'trigger'
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'schema'

export interface DropRequest {
  kind: DropKind
  schema: string
  name: string
  /** Required for kind='trigger' (owning table) and function/procedure (identity args). */
  table?: string
  args?: string
  cascade?: boolean
  /** Must equal the object name — explicit confirmation against accidental drops. */
  confirmName: string
}

export interface TruncateRequest {
  schema: string
  table: string
  restartIdentity?: boolean
  cascade?: boolean
  confirmName: string
}

// ── DDL management ──────────────────────────────────────────────────────────

export interface NewColumnSpec {
  name: string
  /** SQL type, e.g. `integer`, `varchar(120)`, `timestamp with time zone`. */
  type: string
  nullable: boolean
  /** Raw default expression (SQL), e.g. `now()`, `0`, `'new'`. */
  default?: string
  primaryKey?: boolean
}

export interface CreateTableInput {
  schema: string
  name: string
  columns: NewColumnSpec[]
}

export type FkRefAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

export type AlterTableAction =
  | { kind: 'rename_table'; newName: string }
  | { kind: 'rename_column'; column: string; newName: string }
  | { kind: 'add_column'; spec: NewColumnSpec }
  | { kind: 'drop_column'; column: string; cascade?: boolean }
  | { kind: 'set_type'; column: string; type: string; using?: string }
  | { kind: 'set_not_null'; column: string }
  | { kind: 'drop_not_null'; column: string }
  | { kind: 'set_default'; column: string; expression: string }
  | { kind: 'drop_default'; column: string }
  | {
      kind: 'add_foreign_key'
      name?: string
      columns: string[]
      refSchema: string
      refTable: string
      refColumns: string[]
      onDelete: FkRefAction
      onUpdate: FkRefAction
    }
  | { kind: 'add_check'; name?: string; expression: string }
  | { kind: 'drop_constraint'; name: string; cascade?: boolean }
  | { kind: 'set_comment'; target: 'table' | 'column'; column?: string; comment: string | null }

export interface AlterTableRequest {
  actions: AlterTableAction[]
}

export type IndexMethod = 'btree' | 'hash' | 'gin' | 'gist' | 'brin'

export interface CreateIndexInput {
  /** Empty = let PostgreSQL name it. */
  name?: string
  columns: string[]
  unique: boolean
  method: IndexMethod
}

export interface CreateSequenceInput {
  schema: string
  name: string
  startValue?: string
  increment?: string
  minValue?: string
  maxValue?: string
  cycle?: boolean
}

export interface RestartSequenceInput {
  schema: string
  name: string
  restartWith: string
}

export interface RefreshMatviewInput {
  schema: string
  name: string
  concurrently?: boolean
}

export type MaintenanceOp = 'vacuum' | 'vacuum_analyze' | 'analyze' | 'reindex'

export interface MaintenanceRequest {
  op: MaintenanceOp
}

/** Compact schema map used by the SQL editor for autocomplete. */
export interface AutocompleteData {
  schemas: {
    name: string
    tables: { name: string; columns: string[] }[]
  }[]
  keywordsVersion: number
}
