import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArrowRightLeft,
  CalendarClock,
  Download,
  FileText,
  Play,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { BackupRecord, BackupSchedule } from '@pgforge/shared'
import { DbSwitcher } from '../../components/layout/DbSwitcher.js'
import { PathBar } from '../../components/layout/PathBar.js'
import { Badge, Button, EmptyState, StatusBadge } from '../../components/ui/basics.js'
import { ConfirmDialog } from '../../components/ui/overlays.js'
import { Tabs } from '../../components/ui/Tabs.js'
import { api, ApiError, downloadFile } from '../../lib/api.js'
import { formatBytes, formatDate, formatMs } from '../../lib/format.js'
import { useMeta } from '../../lib/queries.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'
import {
  BackupDialog,
  JobLogDialog,
  MigrateDialog,
  RestoreDialog,
  ScheduleDialog,
  UploadRestoreDialog,
} from './dialogs.js'

type BackupTab = 'history' | 'schedules'

export function BackupsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { connId, connection, db, setDb } = useWorkspace()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const meta = useMeta()
  const [tab, setTab] = useState<BackupTab>('history')
  const [dialog, setDialog] = useState<
    | { kind: 'create' }
    | { kind: 'restore'; backup: BackupRecord }
    | { kind: 'upload' }
    | { kind: 'migrate' }
    | { kind: 'schedule'; existing: BackupSchedule | null }
    | { kind: 'log'; jobId: string }
    | { kind: 'delete-backup'; backup: BackupRecord }
    | { kind: 'delete-schedule'; schedule: BackupSchedule }
    | null
  >(null)

  const canEdit = user?.role !== 'viewer'

  const backups = useQuery({
    queryKey: ['backups', connId],
    queryFn: () => api<BackupRecord[]>(`/api/backups?connectionId=${connId}`),
    refetchInterval: (query) =>
      query.state.data?.some((b) => b.status === 'running') ? 2000 : false,
  })

  const schedules = useQuery({
    queryKey: ['backup-schedules'],
    queryFn: () => api<BackupSchedule[]>('/api/backup-schedules'),
    enabled: tab === 'schedules',
  })

  const invalidateBackups = () => void queryClient.invalidateQueries({ queryKey: ['backups', connId] })

  const deleteBackup = useMutation({
    mutationFn: (id: string) => api(`/api/backups/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateBackups()
      setDialog(null)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const deleteSchedule = useMutation({
    mutationFn: (id: string) => api(`/api/backup-schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backup-schedules'] })
      setDialog(null)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const runSchedule = useMutation({
    mutationFn: (id: string) => api(`/api/backup-schedules/${id}/run`, { body: {} }),
    onSuccess: () => {
      toast.ok(t('common.success'))
      invalidateBackups()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const connSchedules = schedules.data?.filter((s) => s.connectionId === connId)

  return (
    <>
      <PathBar
        segments={[
          { kind: 'conn', label: connection.name },
          { kind: 'object', label: 'backups' },
        ]}
        actions={<DbSwitcher connId={connId} db={db} onChange={setDb} />}
      />
      <div className="page">
        {meta.data && !meta.data.pgToolsAvailable && (
          <div className="sql-error" style={{ margin: 0 }}>{t('backup.toolsMissing')}</div>
        )}
        <div className="page-head">
          <div>
            <h1 className="page-title">{t('backup.title')}</h1>
            <p className="page-sub">{t('backup.subtitle')}</p>
          </div>
          {canEdit && (
            <div className="toolbar">
              <Button icon={Upload} onClick={() => setDialog({ kind: 'upload' })}>
                {t('backup.uploadRestore')}
              </Button>
              <Button icon={ArrowRightLeft} onClick={() => setDialog({ kind: 'migrate' })}>
                {t('backup.migrate')}
              </Button>
              <Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: 'create' })}>
                {t('backup.create')}
              </Button>
            </div>
          )}
        </div>

        <Tabs<BackupTab>
          tabs={[
            { key: 'history', label: t('backup.history') },
            { key: 'schedules', label: t('backup.schedules') },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'history' && (
          <div className="panel">
            {backups.data?.length === 0 ? (
              <EmptyState icon={Archive} title={t('backup.noBackups')} />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('backup.file')}</th>
                    <th>{t('monitor.database')}</th>
                    <th>{t('backup.format')}</th>
                    <th>{t('backup.mode')}</th>
                    <th>{t('common.status')}</th>
                    <th className="num">{t('common.size')}</th>
                    <th className="num">{t('common.duration')}</th>
                    <th>{t('common.date')}</th>
                    <th style={{ width: 130 }} />
                  </tr>
                </thead>
                <tbody>
                  {backups.data?.map((backup) => (
                    <tr key={backup.id}>
                      <td className="mono truncate" style={{ maxWidth: 240 }} title={backup.fileName}>
                        {backup.status === 'success' ? (
                          <button
                            type="button"
                            title={t('backup.inspect')}
                            onClick={() => navigate(`/c/${connId}/backups/${backup.id}`)}
                            style={{
                              all: 'unset',
                              cursor: 'pointer',
                              color: 'var(--accent)',
                              font: 'inherit',
                            }}
                          >
                            {backup.fileName}
                          </button>
                        ) : (
                          backup.fileName
                        )}
                      </td>
                      <td className="mono">{backup.database}</td>
                      <td className="muted">{backup.format}</td>
                      <td>
                        <Badge kind={backup.mode === 'scheduled' ? 'accent' : 'muted'}>
                          {t(backup.mode === 'scheduled' ? 'backup.scheduled' : 'backup.manual')}
                        </Badge>
                      </td>
                      <td>
                        <StatusBadge status={backup.status} />
                      </td>
                      <td className="num">{formatBytes(backup.sizeBytes)}</td>
                      <td className="num">{formatMs(backup.durationMs)}</td>
                      <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                        {formatDate(backup.createdAt)}
                      </td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={FileText}
                            aria-label={t('backup.jobLog')}
                            onClick={() => setDialog({ kind: 'log', jobId: backup.jobId })}
                          />
                          {backup.status === 'success' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={Download}
                              aria-label={t('common.download')}
                              onClick={() =>
                                void downloadFile(`/api/backups/${backup.id}/download`).catch(
                                  (err: unknown) =>
                                    toast.error(err instanceof Error ? err.message : String(err)),
                                )
                              }
                            />
                          )}
                          {canEdit && backup.status === 'success' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={Upload}
                              aria-label={t('backup.restore')}
                              onClick={() => setDialog({ kind: 'restore', backup })}
                            />
                          )}
                          {canEdit && backup.status !== 'running' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={Trash2}
                              aria-label={t('common.delete')}
                              onClick={() => setDialog({ kind: 'delete-backup', backup })}
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
        )}

        {tab === 'schedules' && (
          <div className="panel">
            <div className="panel-header">
              {t('backup.schedules')}
              {canEdit && (
                <Button size="sm" icon={Plus} onClick={() => setDialog({ kind: 'schedule', existing: null })}>
                  {t('backup.addSchedule')}
                </Button>
              )}
            </div>
            {connSchedules?.length === 0 ? (
              <EmptyState icon={CalendarClock} title={t('backup.noSchedules')} />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.name')}</th>
                    <th>{t('monitor.database')}</th>
                    <th>{t('backup.cron')}</th>
                    <th className="num">{t('backup.retention')}</th>
                    <th>{t('backup.lastRun')}</th>
                    <th>{t('backup.nextRun')}</th>
                    <th>{t('common.status')}</th>
                    <th style={{ width: 110 }} />
                  </tr>
                </thead>
                <tbody>
                  {connSchedules?.map((schedule) => (
                    <tr key={schedule.id}>
                      <td>{schedule.name}</td>
                      <td className="mono">{schedule.database}</td>
                      <td className="mono">{schedule.cron}</td>
                      <td className="num">{schedule.retention}</td>
                      <td className="mono muted">{formatDate(schedule.lastRunAt)}</td>
                      <td className="mono muted">{formatDate(schedule.nextRunAt)}</td>
                      <td>
                        <Badge kind={schedule.enabled ? 'ok' : 'muted'}>
                          {schedule.enabled ? t('backup.enabled') : '—'}
                        </Badge>
                      </td>
                      <td>
                        {canEdit && (
                          <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={Play}
                              aria-label={t('backup.runNow')}
                              onClick={() => runSchedule.mutate(schedule.id)}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={CalendarClock}
                              aria-label={t('common.edit')}
                              onClick={() => setDialog({ kind: 'schedule', existing: schedule })}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={Trash2}
                              aria-label={t('common.delete')}
                              onClick={() => setDialog({ kind: 'delete-schedule', schedule })}
                            />
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {dialog?.kind === 'create' && (
        <BackupDialog
          connId={connId}
          db={db}
          onDone={(record) => {
            invalidateBackups()
            setDialog({ kind: 'log', jobId: record.jobId })
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'restore' && (
        <RestoreDialog
          backup={dialog.backup}
          onDone={(jobId) => setDialog({ kind: 'log', jobId })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'upload' && (
        <UploadRestoreDialog
          connId={connId}
          onDone={(jobId) => setDialog({ kind: 'log', jobId })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'migrate' && (
        <MigrateDialog
          connId={connId}
          db={db}
          onDone={(jobId) => setDialog({ kind: 'log', jobId })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'schedule' && (
        <ScheduleDialog connId={connId} db={db} existing={dialog.existing} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'log' && (
        <JobLogDialog
          jobId={dialog.jobId}
          onClose={() => {
            setDialog(null)
            invalidateBackups()
          }}
        />
      )}
      {dialog?.kind === 'delete-backup' && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('backup.deleteBackupConfirm', { name: dialog.backup.fileName })}
          loading={deleteBackup.isPending}
          onConfirm={() => deleteBackup.mutate(dialog.backup.id)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete-schedule' && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('backup.deleteScheduleConfirm', { name: dialog.schedule.name })}
          loading={deleteSchedule.isPending}
          onConfirm={() => deleteSchedule.mutate(dialog.schedule.id)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}
