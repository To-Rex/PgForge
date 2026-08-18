export interface PgRoleInfo {
  name: string
  superuser: boolean
  createDb: boolean
  createRole: boolean
  login: boolean
  replication: boolean
  bypassRls: boolean
  connLimit: number
  validUntil: string | null
  memberOf: string[]
  comment: string | null
}

export interface PgRoleInput {
  name: string
  /** Write-only. */
  password?: string
  login: boolean
  superuser: boolean
  createDb: boolean
  createRole: boolean
  replication: boolean
  connLimit?: number
  validUntil?: string | null
  memberOf?: string[]
}

export interface PgRoleUpdate {
  password?: string
  login?: boolean
  superuser?: boolean
  createDb?: boolean
  createRole?: boolean
  replication?: boolean
  connLimit?: number
  validUntil?: string | null
  /** Full desired membership set; server computes grants/revokes. */
  memberOf?: string[]
}

export type TablePrivilegeKind =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'TRUNCATE'
  | 'REFERENCES'
  | 'TRIGGER'

export interface TableGrants {
  grantee: string
  privileges: string[]
}

export interface GrantRequest {
  role: string
  schema: string
  /** Omitted = all tables in schema. */
  table?: string
  privileges: TablePrivilegeKind[]
}

export type RevokeRequest = GrantRequest
