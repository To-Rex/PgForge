import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { CreateDatabaseInput, DatabaseInfo, ServerOverview } from '@pgforge/shared'
import { Button, Checkbox, Field, TextInput } from '../../components/ui/basics.js'
import { ConfirmDialog, Modal } from '../../components/ui/overlays.js'
import { PathBar } from '../../components/layout/PathBar.js'
import { api, ApiError } from '../../lib/api.js'
import { formatBytes, formatCount, formatUptime } from '../../lib/format.js'
import { useDatabases } from '../../lib/queries.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'

export function OverviewPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { connId, connection } = useWorkspace()
  const user = useAuthStore((s) => s.user)
  const [creating, setCreating] = useState(false)
  const [dropping, setDropping] = useState<DatabaseInfo | null>(null)
  const [force, setForce] = useState(false)

  const overview = useQuery({
    queryKey: ['overview', connId],
    queryFn: () => api<ServerOverview>(`/api/connections/${connId}/overview`),
  })
  const databases = useDatabases(connId)

  const canEdit = user?.role !== 'viewer' && !connection.readOnly
  const isAdmin = user?.role === 'admin'

  const drop = useMutation({
    mutationFn: (db: DatabaseInfo) =>
      api(`/api/connections/${connId}/databases/${encodeURIComponent(db.name)}/drop`, {
        body: { force, confirmName: db.name },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['databases', connId] })
      setDropping(null)
      setForce(false)
      toast.ok(t('common.success'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const o = overview.data

  return (
    <>
      <PathBar
        segments={[{ kind: 'conn', label: connection.name }]}
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={RefreshCw}
            onClick={() => {
              void overview.refetch()
              void databases.refetch()
            }}
            aria-label={t('common.refresh')}
          />
        }
      />
      <div className="page">
        {o && (
          <div className="stat-strip">
            <div className="stat-cell">
              <div className="stat-label">{t('conn.serverVersion')}</div>
              <div className="stat-value">{o.serverVersion.split(' ')[1] ?? '—'}</div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">{t('conn.uptime')}</div>
              <div className="stat-value">{formatUptime(o.uptimeSeconds)}</div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">{t('conn.databases')}</div>
              <div className="stat-value">{o.databaseCount}</div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">{t('conn.totalSize')}</div>
              <div className="stat-value">{formatBytes(o.totalSizeBytes)}</div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">{t('conn.activeConnections')}</div>
              <div className="stat-value">
                {o.activeConnections}
                <small>/ {o.maxConnections}</small>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">{t('conn.superuser')}</div>
              <div className="stat-value">{o.isSuperuser ? t('common.yes') : t('common.no')}</div>
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-header">
            {t('db.databases')}
            {canEdit && (
              <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>
                {t('db.createDatabase')}
              </Button>
            )}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.owner')}</th>
                <th>{t('db.encoding')}</th>
                <th className="num">{t('common.size')}</th>
                <th className="num">{t('db.connections')}</th>
                {isAdmin && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {databases.data?.map((db) => (
                <tr
                  key={db.name}
                  className="clickable"
                  onClick={() => navigate(`/c/${connId}/explorer?db=${encodeURIComponent(db.name)}`)}
                >
                  <td className="mono">{db.name}</td>
                  <td className="mono muted">{db.owner}</td>
                  <td className="muted">{db.encoding}</td>
                  <td className="num">{formatBytes(db.sizeBytes)}</td>
                  <td className="num">{formatCount(db.connections)}</td>
                  {isAdmin && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        aria-label={t('db.dropDatabase')}
                        onClick={() => setDropping(db)}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {databases.isLoading && (
            <div className="row" style={{ padding: 16, justifyContent: 'center' }}>
              <span className="spinner" />
            </div>
          )}
        </div>
      </div>

      {creating && <CreateDatabaseDialog connId={connId} onClose={() => setCreating(false)} />}
      {dropping && (
        <ConfirmDialog
          title={t('db.dropDatabase')}
          message={
            <span className="text-danger">{t('db.dropDatabaseWarning')}</span>
          }
          typeToConfirm={dropping.name}
          loading={drop.isPending}
          onConfirm={() => drop.mutate(dropping)}
          onClose={() => {
            setDropping(null)
            setForce(false)
          }}
        >
          <Checkbox label={t('db.forceDrop')} checked={force} onChange={setForce} />
        </ConfirmDialog>
      )}
    </>
  )
}

function CreateDatabaseDialog({ connId, onClose }: { connId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<CreateDatabaseInput>({ name: '' })

  const create = useMutation({
    mutationFn: () =>
      api(`/api/connections/${connId}/databases`, {
        body: {
          name: form.name,
          owner: form.owner || undefined,
          template: form.template || undefined,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['databases', connId] })
      toast.ok(t('common.success'))
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={t('db.createDatabase')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!form.name}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')}>
        <TextInput
          mono
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          autoFocus
        />
      </Field>
      <Field label={`${t('common.owner')} (${t('common.none').toLowerCase()} = current)`}>
        <TextInput
          mono
          value={form.owner ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
        />
      </Field>
      <Field label={t('db.template')}>
        <TextInput
          mono
          placeholder="template1"
          value={form.template ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
        />
      </Field>
    </Modal>
  )
}
