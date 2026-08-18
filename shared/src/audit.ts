export type AuditStatus = 'ok' | 'denied' | 'error'

export interface AuditEntry {
  id: string
  userId: string | null
  userEmail: string | null
  action: string
  target: string | null
  connectionId: string | null
  database: string | null
  details: string | null
  ip: string | null
  status: AuditStatus
  createdAt: string
}

export interface AuditQuery {
  page: number
  pageSize: number
  action?: string
  userId?: string
  connectionId?: string
  from?: string
  to?: string
}

export interface AuditPage {
  entries: AuditEntry[]
  total: number
}
