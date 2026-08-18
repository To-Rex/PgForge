import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, FileClock } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuditPage as AuditPageData } from '@pgforge/shared'
import { Badge, Button, EmptyState, Select } from '../../components/ui/basics.js'
import { api } from '../../lib/api.js'
import { formatDate } from '../../lib/format.js'
import { useConnections } from '../../lib/queries.js'

const PAGE_SIZE = 50

export function AuditPage() {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)
  const [action, setAction] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const connections = useConnections()

  const actions = useQuery({
    queryKey: ['audit-actions'],
    queryFn: () => api<string[]>('/api/audit/actions'),
  })

  const audit = useQuery({
    queryKey: ['audit', page, action, connectionId],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (action) params.set('action', action)
      if (connectionId) params.set('connectionId', connectionId)
      return api<AuditPageData>(`/api/audit?${params}`)
    },
    placeholderData: keepPreviousData,
  })

  const totalPages = audit.data ? Math.max(1, Math.ceil(audit.data.total / PAGE_SIZE)) : 1
  const connName = (id: string | null) =>
    connections.data?.find((c) => c.id === id)?.name ?? ''

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('audit.title')}</h1>
          <p className="page-sub">{t('audit.subtitle')}</p>
        </div>
        <div className="toolbar">
          <Select
            value={action}
            onChange={(e) => {
              setPage(0)
              setAction(e.target.value)
            }}
            style={{ width: 'auto' }}
          >
            <option value="">{t('audit.action')}: {t('common.all')}</option>
            {actions.data?.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <Select
            value={connectionId}
            onChange={(e) => {
              setPage(0)
              setConnectionId(e.target.value)
            }}
            style={{ width: 'auto' }}
          >
            <option value="">{t('nav.connections')}: {t('common.all')}</option>
            {connections.data?.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="panel">
        {audit.data?.entries.length === 0 ? (
          <EmptyState icon={FileClock} title={t('audit.empty')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('audit.when')}</th>
                <th>{t('audit.user')}</th>
                <th>{t('audit.action')}</th>
                <th>{t('audit.target')}</th>
                <th>{t('nav.connections')}</th>
                <th>{t('audit.details')}</th>
                <th>{t('audit.ip')}</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                    {formatDate(entry.createdAt)}
                  </td>
                  <td>{entry.userEmail ?? '—'}</td>
                  <td>
                    <Badge kind={entry.status === 'ok' ? 'accent' : entry.status === 'denied' ? 'warn' : 'danger'}>
                      {entry.action}
                    </Badge>
                  </td>
                  <td className="mono truncate" style={{ maxWidth: 200 }} title={entry.target ?? ''}>
                    {entry.target ?? ''}
                  </td>
                  <td className="muted">{connName(entry.connectionId)}</td>
                  <td className="mono muted truncate" style={{ maxWidth: 320 }} title={entry.details ?? ''}>
                    {entry.details ?? ''}
                  </td>
                  <td className="mono faint">{entry.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="grid-footer">
          <span className="mono">
            {audit.data?.total ?? 0} {t('common.total')}
          </span>
          <span className="grow" />
          <div className="pager">
            <Button variant="ghost" size="sm" icon={ChevronLeft} disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="prev" />
            <span className="mono">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={ChevronRight}
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              aria-label="next"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
