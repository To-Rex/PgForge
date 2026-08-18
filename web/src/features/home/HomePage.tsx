import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Database, MoreHorizontal, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { ConnectionSummary } from '@pgforge/shared'
import { Button, Badge, EmptyState } from '../../components/ui/basics.js'
import { ConfirmDialog, useMenu } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { formatDate } from '../../lib/format.js'
import { useConnections } from '../../lib/queries.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { ConnectionDialog } from '../connections/ConnectionDialog.js'

export function HomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const connections = useConnections()
  const [dialog, setDialog] = useState<{ open: boolean; existing: ConnectionSummary | null }>({
    open: false,
    existing: null,
  })
  const [deleting, setDeleting] = useState<ConnectionSummary | null>(null)
  const { open: openMenu, menu } = useMenu()

  const isAdmin = user?.role === 'admin'

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] })
      setDeleting(null)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('conn.title')}</h1>
          <p className="page-sub">{t('conn.subtitle')}</p>
        </div>
        {isAdmin && (
          <Button variant="primary" icon={Plus} onClick={() => setDialog({ open: true, existing: null })}>
            {t('conn.add')}
          </Button>
        )}
      </div>

      {connections.data && connections.data.length === 0 && (
        <EmptyState
          icon={Database}
          title={t('conn.empty')}
          hint={t('conn.emptyHint')}
          action={
            isAdmin ? (
              <Button variant="primary" icon={Plus} onClick={() => setDialog({ open: true, existing: null })}>
                {t('conn.add')}
              </Button>
            ) : undefined
          }
        />
      )}

      <div className="conn-grid">
        {connections.data?.map((conn) => (
          <div
            key={conn.id}
            className="conn-card"
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/c/${conn.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(`/c/${conn.id}`)
            }}
          >
            <div className="conn-card-head">
              <span className="conn-dot" style={{ background: conn.color ?? 'var(--accent)' }} />
              <span className="conn-name">{conn.name}</span>
              {conn.readOnly && <Badge kind="warn">{t('conn.readOnly')}</Badge>}
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={MoreHorizontal}
                  aria-label={t('common.actions')}
                  onClick={(e) =>
                    openMenu(e, [
                      {
                        label: t('common.edit'),
                        onSelect: () => setDialog({ open: true, existing: conn }),
                      },
                      {
                        label: t('common.delete'),
                        danger: true,
                        onSelect: () => setDeleting(conn),
                      },
                    ])
                  }
                />
              )}
            </div>
            <div className="conn-addr">
              {conn.username}@{conn.host}:{conn.port}/{conn.defaultDatabase}
            </div>
            <div className="row muted" style={{ fontSize: 'var(--text-xs)' }}>
              <span>{t('conn.lastUsed')}:</span>
              <span className="mono">{formatDate(conn.lastUsedAt)}</span>
            </div>
          </div>
        ))}
      </div>

      {menu}
      {dialog.open && (
        <ConnectionDialog
          existing={dialog.existing}
          onClose={() => setDialog({ open: false, existing: null })}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('conn.deleteConfirm', { name: deleting.name })}
          typeToConfirm={deleting.name}
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
