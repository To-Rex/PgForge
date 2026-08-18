import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BackupFormat,
  BackupRecord,
  BackupSchedule,
  BackupScheduleInput,
  CronPreview,
  JobInfo,
} from '@pgforge/shared'
import { Button, Checkbox, Field, Select, StatusBadge, TextInput } from '../../components/ui/basics.js'
import { Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { getAuthHeader as authHeader } from '../../lib/auth-header.js'
import { formatDate } from '../../lib/format.js'
import { useConnections, useDatabases } from '../../lib/queries.js'
import { toast } from '../../stores/toast.js'
import {
  buildCron,
  DEFAULT_SPEC,
  INTERVAL_CHOICES,
  monthName,
  parseCron,
  weekdayName,
  type Frequency,
  type ScheduleSpec,
} from './cron-builder.js'

const FORMATS: BackupFormat[] = ['custom', 'plain', 'tar']

function FormatSelect({
  value,
  onChange,
}: {
  value: BackupFormat
  onChange: (format: BackupFormat) => void
}) {
  const { t } = useTranslation()
  const labels: Record<BackupFormat, string> = {
    custom: t('backup.formatCustom'),
    plain: t('backup.formatPlain'),
    tar: t('backup.formatTar'),
  }
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as BackupFormat)}>
      {FORMATS.map((format) => (
        <option key={format} value={format}>
          {labels[format]}
        </option>
      ))}
    </Select>
  )
}

function DatabasePicker({
  connId,
  value,
  onChange,
}: {
  connId: string
  value: string
  onChange: (db: string) => void
}) {
  const databases = useDatabases(connId)
  useEffect(() => {
    if (!value && databases.data?.[0]) onChange(databases.data[0].name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databases.data])
  return (
    <Select className="mono" value={value} onChange={(e) => onChange(e.target.value)}>
      {databases.data?.map((db) => (
        <option key={db.name} value={db.name}>
          {db.name}
        </option>
      ))}
    </Select>
  )
}

export function BackupDialog({
  connId,
  db,
  onDone,
  onClose,
}: {
  connId: string
  db: string
  onDone: (record: BackupRecord) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [database, setDatabase] = useState(db)
  const [format, setFormat] = useState<BackupFormat>('custom')
  const [scope, setScope] = useState<'all' | 'schema' | 'data'>('all')

  const create = useMutation({
    mutationFn: () =>
      api<BackupRecord>('/api/backups', {
        body: {
          connectionId: connId,
          database,
          format,
          schemaOnly: scope === 'schema' || undefined,
          dataOnly: scope === 'data' || undefined,
        },
      }),
    onSuccess: (record) => onDone(record),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={t('backup.create')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!database} onClick={() => create.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('monitor.database')}>
        <DatabasePicker connId={connId} value={database} onChange={setDatabase} />
      </Field>
      <Field label={t('backup.format')}>
        <FormatSelect value={format} onChange={setFormat} />
      </Field>
      <Field label={t('backup.scope')}>
        <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="all">{t('backup.wholeDb')}</option>
          <option value="schema">{t('backup.schemaOnly')}</option>
          <option value="data">{t('backup.dataOnly')}</option>
        </Select>
      </Field>
    </Modal>
  )
}

export function RestoreDialog({
  backup,
  onDone,
  onClose,
}: {
  backup: BackupRecord
  onDone: (jobId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const connections = useConnections()
  const [connectionId, setConnectionId] = useState(backup.connectionId)
  const [database, setDatabase] = useState(backup.database)
  const [clean, setClean] = useState(false)
  const [create, setCreate] = useState(false)

  const restore = useMutation({
    mutationFn: () =>
      api<{ jobId: string }>(`/api/backups/${backup.id}/restore`, {
        body: { connectionId, database, clean, create },
      }),
    onSuccess: (data) => onDone(data.jobId),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={t('backup.restoreTitle')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={restore.isPending} disabled={!database} onClick={() => restore.mutate()}>
            {t('backup.restore')}
          </Button>
        </>
      }
    >
      <div className="mono muted" style={{ fontSize: 'var(--text-xs)' }}>
        {backup.fileName}
      </div>
      <Field label={t('backup.restoreTarget')}>
        <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
          {connections.data?.map((conn) => (
            <option key={conn.id} value={conn.id}>
              {conn.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('backup.restoreDb')}>
        <TextInput mono value={database} onChange={(e) => setDatabase(e.target.value)} />
      </Field>
      <Checkbox label={t('backup.clean')} checked={clean} onChange={setClean} />
      <Checkbox label={t('backup.createDb')} checked={create} onChange={setCreate} />
      <div className="text-danger" style={{ fontSize: 'var(--text-sm)' }}>
        {t('backup.restoreWarning')}
      </div>
    </Modal>
  )
}

export function UploadRestoreDialog({
  connId,
  onDone,
  onClose,
}: {
  connId: string
  onDone: (jobId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const connections = useConnections()
  const [connectionId, setConnectionId] = useState(connId)
  const [database, setDatabase] = useState('')
  const [clean, setClean] = useState(false)
  const [create, setCreate] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!file || !database) return
    setBusy(true)
    try {
      const form = new FormData()
      // Fields must precede the file part for @fastify/multipart field access.
      form.append('connectionId', connectionId)
      form.append('database', database)
      form.append('clean', String(clean))
      form.append('create', String(create))
      form.append('file', file)
      const res = await fetch('/api/restore/upload', {
        method: 'POST',
        credentials: 'include',
        headers: authHeader(),
        body: form,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? t('errors.generic'))
      }
      const data = (await res.json()) as { jobId: string }
      onDone(data.jobId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('backup.uploadRestore')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} disabled={!file || !database} onClick={() => void submit()}>
            {t('backup.restore')}
          </Button>
        </>
      }
    >
      <Field label={t('backup.file')} hint={t('backup.uploadHint')}>
        <input
          type="file"
          accept=".sql,.dump,.tar,.backup"
          className="input"
          style={{ paddingTop: 4 }}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <Field label={t('backup.restoreTarget')}>
        <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
          {connections.data?.map((conn) => (
            <option key={conn.id} value={conn.id}>
              {conn.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('backup.restoreDb')}>
        <TextInput mono value={database} onChange={(e) => setDatabase(e.target.value)} />
      </Field>
      <Checkbox label={t('backup.clean')} checked={clean} onChange={setClean} />
      <Checkbox label={t('backup.createDb')} checked={create} onChange={setCreate} />
    </Modal>
  )
}

export function MigrateDialog({
  connId,
  db,
  onDone,
  onClose,
}: {
  connId: string
  db: string
  onDone: (jobId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const connections = useConnections()
  const [sourceDb, setSourceDb] = useState(db)
  const [targetConnectionId, setTargetConnectionId] = useState('')
  const [targetDatabase, setTargetDatabase] = useState('')
  const [createDatabase, setCreateDatabase] = useState(true)

  useEffect(() => {
    if (!targetConnectionId && connections.data?.[0]) {
      setTargetConnectionId(connections.data[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.data])

  const migrate = useMutation({
    mutationFn: () =>
      api<{ jobId: string }>('/api/migrations', {
        body: {
          sourceConnectionId: connId,
          sourceDatabase: sourceDb,
          targetConnectionId,
          targetDatabase,
          createDatabase,
        },
      }),
    onSuccess: (data) => onDone(data.jobId),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={t('backup.migrate')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={migrate.isPending}
            disabled={!targetConnectionId || !targetDatabase}
            onClick={() => migrate.mutate()}
          >
            {t('backup.migrate')}
          </Button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>
        {t('backup.migrateHint')}
      </div>
      <Field label={`${t('backup.migrateSource')} (${t('monitor.database')})`}>
        <DatabasePicker connId={connId} value={sourceDb} onChange={setSourceDb} />
      </Field>
      <Field label={t('backup.migrateTarget')}>
        <Select value={targetConnectionId} onChange={(e) => setTargetConnectionId(e.target.value)}>
          {connections.data?.map((conn) => (
            <option key={conn.id} value={conn.id}>
              {conn.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('backup.restoreDb')}>
        <TextInput mono value={targetDatabase} onChange={(e) => setTargetDatabase(e.target.value)} />
      </Field>
      <Checkbox label={t('backup.createDb')} checked={createDatabase} onChange={setCreateDatabase} />
    </Modal>
  )
}

export function ScheduleDialog({
  connId,
  db,
  existing,
  onClose,
}: {
  connId: string
  db: string
  existing: BackupSchedule | null
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const locale = i18n.language
  const [form, setForm] = useState<Omit<BackupScheduleInput, 'cron'>>({
    name: existing?.name ?? '',
    connectionId: existing?.connectionId ?? connId,
    database: existing?.database ?? db,
    format: existing?.format ?? 'custom',
    retention: existing?.retention ?? 7,
    enabled: existing?.enabled ?? true,
  })
  const [spec, setSpec] = useState<ScheduleSpec>(() =>
    existing ? parseCron(existing.cron) : { ...DEFAULT_SPEC },
  )
  const cron = buildCron(spec)

  const preview = useQuery({
    queryKey: ['cron-preview', cron],
    queryFn: () => api<CronPreview>('/api/backup-schedules/preview', { body: { cron } }),
    enabled: cron.length >= 5,
    staleTime: 60_000,
  })
  const cronValid = preview.data?.valid ?? false

  const set = (patch: Partial<ScheduleSpec>) => setSpec((s) => ({ ...s, ...patch }))

  const save = useMutation({
    mutationFn: () =>
      existing
        ? api(`/api/backup-schedules/${existing.id}`, { method: 'PUT', body: { ...form, cron } })
        : api('/api/backup-schedules', { body: { ...form, cron } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backup-schedules'] })
      toast.ok(t('common.success'))
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const timeValue = `${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`
  const setTime = (value: string) => {
    const [hour, minute] = value.split(':').map(Number)
    if (Number.isInteger(hour) && Number.isInteger(minute)) set({ hour, minute })
  }

  const showTime = ['daily', 'weekly', 'monthly', 'yearly'].includes(spec.frequency)
  const showMinute = spec.frequency === 'hourly' || spec.frequency === 'interval'
  const frequencies: Frequency[] = ['hourly', 'interval', 'daily', 'weekly', 'monthly', 'yearly', 'custom']
  const freqLabels: Record<Frequency, string> = {
    hourly: t('backup.freqHourly'),
    interval: t('backup.freqInterval'),
    daily: t('backup.freqDaily'),
    weekly: t('backup.freqWeekly'),
    monthly: t('backup.freqMonthly'),
    yearly: t('backup.freqYearly'),
    custom: t('backup.freqCustom'),
  }

  return (
    <Modal
      title={existing ? t('common.edit') : t('backup.addSchedule')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!form.name || !form.database || !cronValid}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('common.name')}>
          <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
        </Field>
        <Field label={t('monitor.database')}>
          <DatabasePicker
            connId={form.connectionId}
            value={form.database}
            onChange={(database) => setForm((f) => ({ ...f, database }))}
          />
        </Field>
        <Field label={t('backup.format')}>
          <FormatSelect value={form.format} onChange={(format) => setForm((f) => ({ ...f, format }))} />
        </Field>
        <Field label={t('backup.retention')}>
          <TextInput
            type="number"
            min={1}
            max={365}
            value={form.retention}
            onChange={(e) => setForm((f) => ({ ...f, retention: Number(e.target.value) }))}
          />
        </Field>
      </div>

      <div className="form-grid">
        <Field label={t('backup.freq')}>
          <Select value={spec.frequency} onChange={(e) => set({ frequency: e.target.value as Frequency })}>
            {frequencies.map((freq) => (
              <option key={freq} value={freq}>
                {freqLabels[freq]}
              </option>
            ))}
          </Select>
        </Field>
        {spec.frequency === 'interval' && (
          <Field label={t('backup.everyHours')}>
            <Select
              value={spec.intervalHours}
              onChange={(e) => set({ intervalHours: Number(e.target.value) })}
            >
              {INTERVAL_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {showMinute && (
          <Field label={t('backup.atMinute')}>
            <TextInput
              type="number"
              min={0}
              max={59}
              value={spec.minute}
              onChange={(e) => set({ minute: Math.min(Math.max(Number(e.target.value) || 0, 0), 59) })}
            />
          </Field>
        )}
        {showTime && (
          <Field label={t('backup.atTime')}>
            <input type="time" className="input mono" value={timeValue} onChange={(e) => setTime(e.target.value)} />
          </Field>
        )}
        {spec.frequency === 'weekly' && (
          <Field label={t('backup.onWeekday')}>
            <Select value={spec.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 0].map((weekday) => (
                <option key={weekday} value={weekday}>
                  {weekdayName(weekday, locale)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {(spec.frequency === 'monthly' || spec.frequency === 'yearly') && (
          <Field label={t('backup.onDay')}>
            <TextInput
              type="number"
              min={1}
              max={31}
              value={spec.dayOfMonth}
              onChange={(e) => set({ dayOfMonth: Math.min(Math.max(Number(e.target.value) || 1, 1), 31) })}
            />
          </Field>
        )}
        {spec.frequency === 'yearly' && (
          <Field label={t('backup.inMonth')}>
            <Select value={spec.month} onChange={(e) => set({ month: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => (
                <option key={month} value={month}>
                  {monthName(month, locale)}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {spec.frequency === 'custom' && (
        <Field label={t('backup.cron')} hint={t('backup.cronHint')}>
          <TextInput mono value={spec.custom} onChange={(e) => set({ custom: e.target.value })} />
        </Field>
      )}

      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '10px 12px',
          background: 'var(--bg-sunken)',
        }}
      >
        <div className="field-label" style={{ marginBottom: 6 }}>
          {t('backup.upcoming')} · <span className="mono">{cron}</span>
        </div>
        {preview.isLoading ? (
          <span className="spinner" />
        ) : cronValid ? (
          <div className="mono" style={{ fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {preview.data?.nextRuns.map((run) => <span key={run}>{formatDate(run)}</span>)}
          </div>
        ) : (
          <span className="text-danger" style={{ fontSize: 'var(--text-sm)' }}>
            {t('backup.invalidCron')}
          </span>
        )}
      </div>

      <Checkbox
        label={t('backup.enabled')}
        checked={form.enabled}
        onChange={(enabled) => setForm((f) => ({ ...f, enabled }))}
      />
    </Modal>
  )
}

export function JobLogDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const logRef = useRef<HTMLPreElement>(null)

  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api<JobInfo>(`/api/jobs/${jobId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'running' || status === 'queued' ? 1000 : false
    },
  })

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [job.data?.log])

  const cancel = useMutation({
    mutationFn: () => api(`/api/jobs/${jobId}/cancel`, { body: {} }),
    onSuccess: () => void job.refetch(),
  })

  const info = job.data

  return (
    <Modal
      title={t('backup.jobLog')}
      onClose={onClose}
      wide
      footer={
        <>
          {info?.status === 'running' && (
            <Button variant="danger-outline" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              {t('common.cancel')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="row">
        {info && <StatusBadge status={info.status} />}
        {info?.status === 'running' && <span className="spinner" />}
        {info?.error && <span className="text-danger" style={{ fontSize: 'var(--text-sm)' }}>{info.error}</span>}
      </div>
      <pre ref={logRef} className="log-view" style={{ minHeight: 200 }}>
        {info?.log || '…'}
      </pre>
    </Modal>
  )
}
