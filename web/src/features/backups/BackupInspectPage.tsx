import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveRestore, ArrowLeft, Table2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { BackupInspection, BackupRecord, JobInfo } from '@pgforge/shared'
import { PathBar, type PathSegment } from '../../components/layout/PathBar.js'
import { Badge, Button, EmptyState, StatusBadge } from '../../components/ui/basics.js'
import { ConfirmDialog } from '../../components/ui/overlays.js'
import { QueryError } from '../../components/ui/QueryError.js'
import { Tabs } from '../../components/ui/Tabs.js'
import { api, ApiError } from '../../lib/api.js'
import { formatBytes, formatDate } from '../../lib/format.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { DataGrid } from '../explorer/DataGrid.js'
import { RoutinesPanel, SequencesPanel } from '../explorer/RoutinesPanel.js'
import { SchemaTree, type TreeSelection } from '../explorer/SchemaTree.js'
import { StructureView } from '../explorer/StructureView.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'

type ViewTab = 'data' | 'structure'

export function BackupInspectPage() {
  const { t } = useTranslation()
  const { connId, connection } = useWorkspace()
  const { backupId } = useParams<{ backupId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const [searchParams, setSearchParams] = useSearchParams()
  const [confirmClose, setConfirmClose] = useState(false)

  const canEdit = user?.role !== 'viewer'
  const backupsUrl = `/c/${connId}/backups`

  const backup = useQuery({
    queryKey: ['backup', backupId],
    queryFn: () => api<BackupRecord>(`/api/backups/${backupId}`),
  })

  const inspection = useQuery({
    queryKey: ['backup-inspect', backupId],
    queryFn: () => api<BackupInspection>(`/api/backups/${backupId}/inspect`),
    refetchInterval: (query) => (query.state.data?.status === 'preparing' ? 1500 : false),
  })

  const job = useQuery({
    queryKey: ['job', inspection.data?.jobId],
    queryFn: () => api<JobInfo>(`/api/jobs/${inspection.data!.jobId}`),
    enabled: inspection.data?.status === 'preparing' && inspection.data.jobId !== null,
    refetchInterval: 1000,
  })

  const start = useMutation({
    mutationFn: () => api<BackupInspection>(`/api/backups/${backupId}/inspect`, { body: {} }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['backup-inspect', backupId] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const close = useMutation({
    mutationFn: () => api(`/api/backups/${backupId}/inspect`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backup-inspect', backupId] })
      navigate(backupsUrl)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const schema = searchParams.get('schema')
  const table = searchParams.get('table')
  const group = searchParams.get('group') as 'routines' | 'sequences' | null
  const tab = (searchParams.get('tab') as ViewTab | null) ?? 'data'

  const select = (selection: TreeSelection) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      params.set('schema', selection.schema)
      if (selection.kind === 'relation') {
        params.set('table', selection.name)
        params.delete('group')
      } else {
        params.set('group', selection.kind)
        params.delete('table')
      }
      return params
    })
  }

  const setTab = (next: ViewTab) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      params.set('tab', next)
      return params
    })
  }

  const info = backup.data
  const state = inspection.data
  const db = state?.database ?? ''

  const segments: PathSegment[] = [
    { kind: 'conn', label: connection.name },
    { kind: 'object', label: info?.fileName ?? '…', onClick: () => navigate(backupsUrl) },
  ]
  if (state?.status === 'ready') {
    if (schema) segments.push({ kind: 'schema', label: schema })
    if (table) segments.push({ kind: 'object', label: table })
  }

  return (
    <>
      <PathBar
        segments={segments}
        actions={
          <>
            {state?.status === 'ready' && (
              <Badge kind="warn">
                {t('backup.inspectDb')}: <span className="mono">{db}</span>
              </Badge>
            )}
            {canEdit && state && state.status !== 'none' && (
              <Button size="sm" icon={X} onClick={() => setConfirmClose(true)}>
                {t('backup.inspectClose')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={ArrowLeft}
              onClick={() => navigate(backupsUrl)}
              aria-label={t('backup.backToList')}
            />
          </>
        }
      />

      {backup.isError && (
        <div className="page">
          <QueryError error={backup.error} onRetry={() => void backup.refetch()} />
        </div>
      )}

      {info && state?.status !== 'ready' && (
        <div className="page">
          <div className="panel" style={{ maxWidth: 640, margin: '32px auto', width: '100%' }}>
            <div className="panel-header">
              <span className="row">
                <ArchiveRestore size={15} />
                {t('backup.inspect')}
              </span>
              <StatusBadge status={info.status} />
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="mono" style={{ fontSize: 'var(--text-sm)', wordBreak: 'break-all' }}>
                {info.fileName}
              </div>
              <div className="row muted" style={{ fontSize: 'var(--text-xs)', flexWrap: 'wrap' }}>
                <span className="mono">{info.database}</span>
                <span>·</span>
                <span>{info.format}</span>
                <span>·</span>
                <span className="mono">{formatBytes(info.sizeBytes)}</span>
                <span>·</span>
                <span className="mono">{formatDate(info.createdAt)}</span>
              </div>
              <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                {t('backup.inspectHint')}
              </div>

              {(state?.status === 'none' || !state) && canEdit && (
                <Button
                  variant="primary"
                  icon={ArchiveRestore}
                  loading={start.isPending}
                  disabled={info.status !== 'success'}
                  onClick={() => start.mutate()}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {t('backup.inspectPrepare')}
                </Button>
              )}

              {state?.status === 'preparing' && (
                <>
                  <div className="row">
                    <span className="spinner" />
                    <span>{t('backup.inspectPreparing')}</span>
                  </div>
                  {job.data?.log && <pre className="log-view">{job.data.log}</pre>}
                </>
              )}

              {state?.status === 'failed' && (
                <>
                  <div className="sql-error" style={{ margin: 0 }}>
                    {t('backup.inspectFailed')}
                    {state.error ? `\n${state.error}` : ''}
                  </div>
                  {canEdit && (
                    <Button
                      variant="primary"
                      loading={start.isPending}
                      onClick={() => start.mutate()}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      {t('common.retry')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {state?.status === 'ready' && db && (
        <div className="explorer">
          <SchemaTree
            connId={connId}
            db={db}
            selectedSchema={schema}
            selectedTable={table}
            selectedGroup={group}
            onSelect={select}
          />
          <div className="content-pane">
            {schema && table ? (
              <>
                <Tabs<ViewTab>
                  tabs={[
                    { key: 'data', label: t('explorer.data') },
                    { key: 'structure', label: t('explorer.structure') },
                  ]}
                  active={tab}
                  onChange={setTab}
                />
                {tab === 'data' ? (
                  <DataGrid key={`${db}.${schema}.${table}`} connId={connId} db={db} schema={schema} table={table} />
                ) : (
                  <StructureView key={`${db}.${schema}.${table}`} connId={connId} db={db} schema={schema} table={table} />
                )}
              </>
            ) : schema && group === 'routines' ? (
              <RoutinesPanel connId={connId} db={db} schema={schema} />
            ) : schema && group === 'sequences' ? (
              <SequencesPanel connId={connId} db={db} schema={schema} />
            ) : (
              <EmptyState icon={Table2} title={t('explorer.noTable')} hint={t('explorer.noTableHint')} />
            )}
          </div>
        </div>
      )}

      {confirmClose && (
        <ConfirmDialog
          title={t('backup.inspectClose')}
          message={t('backup.inspectCloseConfirm', { db })}
          loading={close.isPending}
          onConfirm={() => close.mutate()}
          onClose={() => setConfirmClose(false)}
        />
      )}
    </>
  )
}
