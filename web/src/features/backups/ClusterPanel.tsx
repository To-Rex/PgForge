import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Download, HardDriveDownload, Server, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ClusterBackupContents,
  ClusterBackupRecord,
  ConnectionSummary,
} from '@pgforge/shared'
import { Badge, Button, Checkbox, EmptyState, Field, Select, StatusBadge } from '../../components/ui/basics.js'
import { ConfirmDialog, Modal } from '../../components/ui/overlays.js'
import { api, ApiError, downloadFile } from '../../lib/api.js'
import { formatBytes, formatDate, formatMs } from '../../lib/format.js'
import { useConnections } from '../../lib/queries.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { JobLogDialog } from './dialogs.js'

/**
 * Whole-server bundles: every database as its own custom-format dump, plus the
 * cluster-wide roles, in a single tar. Separate from the per-database history
 * because they restore differently — database by database, out of one file.
 */
export function ClusterPanel({
  connId,
  connection,
}: {
  connId: string
  connection: ConnectionSummary
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const canEdit = user?.role !== 'viewer'
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState<ClusterBackupRecord | null>(null)
  const [deleting, setDeleting] = useState<ClusterBackupRecord | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)

  const backups = useQuery({
    queryKey: ['cluster-backups', connId],
    queryFn: () => api<ClusterBackupRecord[]>(`/api/cluster-backups?connectionId=${connId}`),
    // A run is several processes in sequence; poll while any is unfinished.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((b) => b.status === 'running') ? 2000 : false,
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['cluster-backups'] })

  const remove = useMutation({
    mutationFn: (record: ClusterBackupRecord) =>
      api(`/api/cluster-backups/${record.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate()
      setDeleting(null)
      toast.ok(t('common.success'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <p className="page-sub" style={{ margin: 0, maxWidth: 720 }}>
          {t('cluster.intro')}
        </p>
        {canEdit && (
          <Button variant="primary" icon={Server} onClick={() => setCreating(true)}>
            {t('cluster.create')}
          </Button>
        )}
      </div>

      <div className="panel">
        {backups.data?.length === 0 ? (
          <EmptyState icon={Archive} title={t('cluster.empty')} hint={t('cluster.emptyHint')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('backup.file')}</th>
                <th className="num">{t('cluster.databases')}</th>
                <th>{t('cluster.globals')}</th>
                <th>{t('common.status')}</th>
                <th className="num">{t('common.size')}</th>
                <th className="num">{t('common.duration')}</th>
                <th>{t('common.date')}</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {backups.data?.map((backup) => (
                <tr key={backup.id}>
                  <td className="mono truncate" style={{ maxWidth: 260 }} title={backup.fileName}>
                    {backup.fileName}
                  </td>
                  <td className="num mono" title={backup.databases.join(', ')}>
                    {backup.databases.length}
                  </td>
                  <td>
                    {backup.includesGlobals ? (
                      <Badge kind="ok">{t('common.yes')}</Badge>
                    ) : (
                      <Badge kind="muted">{t('common.no')}</Badge>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={backup.status} />
                    {backup.error && (
                      <div className="text-danger truncate" style={{ fontSize: 10, maxWidth: 220 }}>
                        {backup.error}
                      </div>
                    )}
                  </td>
                  <td className="num">{formatBytes(backup.sizeBytes)}</td>
                  <td className="num">{formatMs(backup.durationMs)}</td>
                  <td className="mono muted">{formatDate(backup.createdAt)}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                      {backup.status === 'running' && (
                        <Button size="sm" variant="ghost" onClick={() => setJobId(backup.jobId)}>
                          {t('backup.viewLog')}
                        </Button>
                      )}
                      {backup.status === 'success' && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Download}
                            aria-label={t('common.download')}
                            onClick={() =>
                              void downloadFile(
                                `/api/cluster-backups/${backup.id}/download`,
                              ).catch((err: unknown) =>
                                toast.error(err instanceof Error ? err.message : String(err)),
                              )
                            }
                          />
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={HardDriveDownload}
                              aria-label={t('cluster.restore')}
                              onClick={() => setRestoring(backup)}
                            />
                          )}
                        </>
                      )}
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Trash2}
                          aria-label={t('common.delete')}
                          onClick={() => setDeleting(backup)}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateClusterDialog
          connId={connId}
          connectionName={connection.name}
          onClose={() => setCreating(false)}
          onStarted={(record) => {
            setCreating(false)
            invalidate()
            setJobId(record.jobId)
          }}
        />
      )}
      {restoring && (
        <RestoreClusterDialog
          record={restoring}
          onClose={() => setRestoring(null)}
          onStarted={(id) => {
            setRestoring(null)
            setJobId(id)
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('common.delete')}
          message={deleting.fileName}
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
      {jobId && (
        <JobLogDialog
          jobId={jobId}
          onClose={() => {
            setJobId(null)
            invalidate()
          }}
        />
      )}
    </>
  )
}

function CreateClusterDialog({
  connId,
  connectionName,
  onClose,
  onStarted,
}: {
  connId: string
  connectionName: string
  onClose: () => void
  onStarted: (record: ClusterBackupRecord) => void
}) {
  const { t } = useTranslation()
  const [includeGlobals, setIncludeGlobals] = useState(true)
  const [selected, setSelected] = useState<Set<string> | null>(null)

  const databases = useQuery({
    queryKey: ['cluster-databases', connId],
    queryFn: () => api<string[]>(`/api/cluster-backups/databases/${connId}`),
  })

  const all = databases.data ?? []
  // null means "everything", including databases created after this dialog
  // was opened — the common intent for a whole-server backup.
  const chosen = selected ?? new Set(all)

  const toggle = (name: string) => {
    setSelected(() => {
      const next = new Set(chosen)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const create = useMutation({
    mutationFn: () =>
      api<ClusterBackupRecord>('/api/cluster-backups', {
        body: {
          connectionId: connId,
          databases: selected === null ? undefined : [...chosen],
          includeGlobals,
        },
      }),
    onSuccess: onStarted,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={`${t('cluster.create')} · ${connectionName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={chosen.size === 0}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('cluster.start')}
          </Button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0, fontSize: 'var(--text-sm)' }}>
        {t('cluster.createHint')}
      </p>
      <Checkbox
        label={t('cluster.includeGlobals')}
        checked={includeGlobals}
        onChange={setIncludeGlobals}
      />
      <Field label={t('cluster.databasesToInclude')} hint={t('cluster.databasesHint')}>
        <div className="cluster-db-list">
          {databases.isLoading && <span className="spinner" />}
          {all.map((name) => (
            <Checkbox
              key={name}
              label={<span className="mono">{name}</span>}
              checked={chosen.has(name)}
              onChange={() => toggle(name)}
            />
          ))}
        </div>
      </Field>
    </Modal>
  )
}

function RestoreClusterDialog({
  record,
  onClose,
  onStarted,
}: {
  record: ClusterBackupRecord
  onClose: () => void
  onStarted: (jobId: string) => void
}) {
  const { t } = useTranslation()
  const connections = useConnections()
  const [target, setTarget] = useState(record.connectionId)
  const [restoreGlobals, setRestoreGlobals] = useState(false)
  const [createDatabases, setCreateDatabases] = useState(true)
  const [clean, setClean] = useState(false)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  const contents = useQuery({
    queryKey: ['cluster-contents', record.id],
    queryFn: () => api<ClusterBackupContents>(`/api/cluster-backups/${record.id}/contents`),
  })

  const all = contents.data?.databases.map((d) => d.name) ?? []
  const chosen = selected ?? new Set(all)

  const toggle = (name: string) => {
    setSelected(() => {
      const next = new Set(chosen)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const restore = useMutation({
    mutationFn: () =>
      api<{ jobId: string }>(`/api/cluster-backups/${record.id}/restore`, {
        body: {
          connectionId: target,
          databases: selected === null ? undefined : [...chosen],
          restoreGlobals,
          createDatabases,
          clean,
        },
      }),
    onSuccess: (result) => onStarted(result.jobId),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={t('cluster.restore')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={!confirmed || (chosen.size === 0 && !restoreGlobals)}
            loading={restore.isPending}
            onClick={() => restore.mutate()}
          >
            {t('cluster.restore')}
          </Button>
        </>
      }
    >
      <Field label={t('cluster.restoreInto')}>
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>
          {connections.data?.map((conn) => (
            <option key={conn.id} value={conn.id}>
              {conn.name} — {conn.host}:{conn.port}
            </option>
          ))}
        </Select>
      </Field>

      <div className="sql-error" style={{ margin: '4px 0' }}>
        {t('cluster.restoreWarning')}
      </div>

      <Checkbox
        label={t('cluster.createDatabases')}
        checked={createDatabases}
        onChange={setCreateDatabases}
      />
      <Checkbox label={t('cluster.cleanFirst')} checked={clean} onChange={setClean} />
      <Checkbox
        label={t('cluster.restoreGlobals')}
        checked={restoreGlobals}
        onChange={setRestoreGlobals}
        disabled={!contents.data?.includesGlobals}
      />

      <Field label={t('cluster.databasesToRestore')}>
        <div className="cluster-db-list">
          {contents.isLoading && <span className="spinner" />}
          {contents.data?.databases.map((db) => (
            <Checkbox
              key={db.name}
              label={
                <span>
                  <span className="mono">{db.name}</span>{' '}
                  <span className="faint">{formatBytes(db.sizeBytes)}</span>
                </span>
              }
              checked={chosen.has(db.name)}
              onChange={() => toggle(db.name)}
            />
          ))}
        </div>
      </Field>

      <Checkbox
        label={t('cluster.confirmUnderstood')}
        checked={confirmed}
        onChange={setConfirmed}
      />
    </Modal>
  )
}
