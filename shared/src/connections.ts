export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

export interface ConnectionSummary {
  id: string
  name: string
  host: string
  port: number
  username: string
  defaultDatabase: string
  sslMode: SslMode
  color: string | null
  readOnly: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export interface ConnectionInput {
  name: string
  host: string
  port: number
  username: string
  /** Write-only; never returned by the API. Optional on update (keeps current). */
  password?: string
  defaultDatabase: string
  sslMode: SslMode
  color?: string | null
  readOnly?: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  serverVersion?: string
  latencyMs?: number
  error?: string
}

export interface ServerOverview {
  serverVersion: string
  versionNumber: number
  uptimeSeconds: number
  totalSizeBytes: number
  databaseCount: number
  activeConnections: number
  maxConnections: number
  isSuperuser: boolean
}
