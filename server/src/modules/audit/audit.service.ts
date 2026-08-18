import type { AuditEntry, AuditPage, AuditQuery, AuditStatus } from '@pgforge/shared'
import { newId, nowIso, truncate } from '../../core/util.js'
import type { MetaStore } from '../../infra/store.js'

export interface AuditActor {
  id: string
  email: string
}

export interface AuditEvent {
  actor: AuditActor | null
  action: string
  target?: string
  connectionId?: string
  database?: string
  details?: string
  ip?: string
  status?: AuditStatus
}

interface Row {
  id: string
  user_id: string | null
  user_email: string | null
  action: string
  target: string | null
  connection_id: string | null
  database: string | null
  details: string | null
  ip: string | null
  status: AuditStatus
  created_at: string
}

const toEntry = (r: Row): AuditEntry => ({
  id: r.id,
  userId: r.user_id,
  userEmail: r.user_email,
  action: r.action,
  target: r.target,
  connectionId: r.connection_id,
  database: r.database,
  details: r.details,
  ip: r.ip,
  status: r.status,
  createdAt: r.created_at,
})

export class AuditService {
  constructor(private readonly store: MetaStore) {}

  log(event: AuditEvent): void {
    this.store.run(
      `INSERT INTO audit_log (id, user_id, user_email, action, target, connection_id, database, details, ip, status, created_at)
       VALUES (:id, :userId, :userEmail, :action, :target, :connectionId, :database, :details, :ip, :status, :createdAt)`,
      {
        id: newId(),
        userId: event.actor?.id ?? null,
        userEmail: event.actor?.email ?? null,
        action: event.action,
        target: event.target ?? null,
        connectionId: event.connectionId ?? null,
        database: event.database ?? null,
        details: event.details ? truncate(event.details, 4000) : null,
        ip: event.ip ?? null,
        status: event.status ?? 'ok',
        createdAt: nowIso(),
      },
    )
  }

  query(q: AuditQuery): AuditPage {
    const where: string[] = []
    const params: Record<string, string | number> = {}
    if (q.action) {
      where.push('action = :action')
      params.action = q.action
    }
    if (q.userId) {
      where.push('user_id = :userId')
      params.userId = q.userId
    }
    if (q.connectionId) {
      where.push('connection_id = :connectionId')
      params.connectionId = q.connectionId
    }
    if (q.from) {
      where.push('created_at >= :from')
      params.from = q.from
    }
    if (q.to) {
      where.push('created_at <= :to')
      params.to = q.to
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total =
      this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log ${clause}`, params)?.n ?? 0
    const entries = this.store
      .all<Row>(
        `SELECT * FROM audit_log ${clause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
        { ...params, limit: q.pageSize, offset: q.page * q.pageSize },
      )
      .map(toEntry)
    return { entries, total }
  }

  distinctActions(): string[] {
    return this.store
      .all<{ action: string }>('SELECT DISTINCT action FROM audit_log ORDER BY action')
      .map((r) => r.action)
  }
}
