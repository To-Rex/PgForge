import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ClipboardCopy, Database, HardDrive, RefreshCw, Upload } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MetadataSaveResult, MetadataStatus, MetadataTestResult } from '@pgforge/shared'
import { Badge, Button, Checkbox, Field, TextInput } from '../../components/ui/basics.js'
import { ConfirmDialog } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { formatBytes, formatDate } from '../../lib/format.js'
import { toast } from '../../stores/toast.js'

/**
 * Where PgForge keeps its own data. The panel is deliberately explicit about
 * two things operators get wrong: the setting only applies after a restart,
 * and writing it into `.env` is durable only where that file itself survives
 * the deploy — otherwise the platform's own environment editor is the place.
 */
export function StoragePanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [createDatabase, setCreateDatabase] = useState(false)
  const [test, setTest] = useState<MetadataTestResult | null>(null)
  const [saved, setSaved] = useState<MetadataSaveResult | null>(null)
  const [reverting, setReverting] = useState(false)

  const status = useQuery({
    queryKey: ['metadata-status'],
    queryFn: () => api<MetadataStatus>('/api/system/metadata'),
  })

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['metadata-status'] })

  const runTest = useMutation({
    mutationFn: () =>
      api<MetadataTestResult>('/api/system/metadata/test', { body: { url, createDatabase } }),
    onSuccess: (result) => {
      setTest(result)
      if (result.ok) toast.ok(t('storage.testOk'))
      else toast.error(result.error ?? t('errors.generic'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const save = useMutation({
    mutationFn: () =>
      api<MetadataSaveResult>('/api/system/metadata', {
        method: 'PUT',
        body: { url, createDatabase },
      }),
    onSuccess: (result) => {
      setSaved(result)
      refresh()
      toast.ok(t('storage.savedNeedsRestart'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const revert = useMutation({
    mutationFn: () => api<MetadataSaveResult>('/api/system/metadata', { method: 'DELETE' }),
    onSuccess: (result) => {
      setSaved(result)
      setReverting(false)
      refresh()
      toast.ok(t('storage.savedNeedsRestart'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const flush = useMutation({
    mutationFn: () => api<MetadataStatus>('/api/system/metadata/flush', { body: {} }),
    onSuccess: () => {
      refresh()
      toast.ok(t('storage.flushed'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.ok(t('common.copied')))
      .catch(() => toast.error(t('errors.generic')))
  }

  const s = status.data
  const isPostgres = s?.mode === 'postgres'

  return (
    <div className="panel">
      <div className="panel-header">
        {t('storage.title')}
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          loading={status.isFetching}
          onClick={refresh}
          aria-label={t('common.refresh')}
        />
      </div>

      <div className="storage-body">
        <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          {t('storage.intro')}
        </p>

        {s && (
          <div className="storage-current">
            <div className="row" style={{ gap: 8 }}>
              {isPostgres ? <Database size={15} /> : <HardDrive size={15} />}
              <strong>{isPostgres ? t('storage.modePostgres') : t('storage.modeSqlite')}</strong>
              <Badge kind={isPostgres ? 'ok' : 'muted'}>{t(`storage.source_${s.source}`)}</Badge>
              {s.restartRequired && (
                <Badge kind="warn">
                  <AlertTriangle size={10} style={{ marginRight: 3, verticalAlign: -1 }} />
                  {t('storage.pendingRestart')}
                </Badge>
              )}
            </div>

            <div className="storage-facts">
              {isPostgres && s.maskedUrl && (
                <Fact label={t('storage.target')} value={s.maskedUrl} mono />
              )}
              <Fact label={t('storage.localSize')} value={formatBytes(s.localBytes)} mono />
              {isPostgres && (
                <>
                  <Fact
                    label={t('storage.snapshot')}
                    value={
                      s.snapshot
                        ? `${formatBytes(s.snapshot.byteSize)} · rev ${s.snapshot.revision}`
                        : t('storage.noSnapshot')
                    }
                    mono
                  />
                  <Fact
                    label={t('storage.lastSynced')}
                    value={s.lastSyncedAt ? formatDate(s.lastSyncedAt) : '—'}
                    mono
                  />
                </>
              )}
            </div>

            {s.lastError && <div className="storage-error">{s.lastError}</div>}

            {/* Backup artifacts are files, not rows — the snapshot cannot carry them. */}
            <div className="storage-note">
              {t('storage.backupsNote', { dir: s.backupDir })}
            </div>

            {isPostgres && (
              <div className="row">
                <Button
                  size="sm"
                  icon={Upload}
                  loading={flush.isPending}
                  onClick={() => flush.mutate()}
                >
                  {t('storage.flushNow')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setReverting(true)}>
                  {t('storage.revertToSqlite')}
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="storage-form">
          <Field
            label={t('storage.connectionString')}
            hint={t('storage.connectionStringHint')}
          >
            <TextInput
              mono
              value={url}
              placeholder="postgresql://user:password@host:5432/pgforge?sslmode=require"
              onChange={(e) => {
                setUrl(e.target.value)
                setTest(null)
                setSaved(null)
              }}
            />
          </Field>
          <Checkbox
            label={t('storage.createDatabase')}
            checked={createDatabase}
            onChange={setCreateDatabase}
          />
          <div className="row">
            <Button
              size="sm"
              disabled={!url.trim()}
              loading={runTest.isPending}
              onClick={() => runTest.mutate()}
            >
              {t('storage.test')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!test?.ok}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.save')}
            </Button>
          </div>

          {test && (
            <div className={test.ok ? 'storage-result ok' : 'storage-result bad'}>
              {test.ok ? (
                <>
                  <div>
                    {t('storage.connectedTo', { database: test.database ?? '?' })}
                    {test.databaseCreated ? ` · ${t('storage.databaseCreated')}` : ''}
                  </div>
                  <div className="mono faint">{test.serverVersion}</div>
                  <div>
                    {test.snapshot
                      ? t('storage.willAdopt', {
                          size: formatBytes(test.snapshot.byteSize),
                          date: formatDate(test.snapshot.updatedAt),
                        })
                      : t('storage.willSeed')}
                  </div>
                </>
              ) : (
                test.error
              )}
            </div>
          )}

          {saved && (
            <div className="storage-result ok">
              <div>
                <strong>{t('storage.savedNeedsRestart')}</strong>
              </div>
              {saved.seededBytes !== null && (
                <div>{t('storage.seeded', { size: formatBytes(saved.seededBytes) })}</div>
              )}
              <div>
                {saved.envWritten
                  ? t('storage.envWritten', { path: saved.envPath })
                  : t('storage.envNotWritten')}
              </div>
              <div className="storage-envline">
                <code className="mono">{saved.envLine}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={ClipboardCopy}
                  onClick={() => copy(saved.envLine)}
                  aria-label={t('common.copy')}
                />
              </div>
              <div className="muted">{t('storage.platformEnvHint')}</div>
            </div>
          )}
        </div>
      </div>

      {reverting && (
        <ConfirmDialog
          title={t('storage.revertToSqlite')}
          message={t('storage.revertConfirm')}
          loading={revert.isPending}
          onConfirm={() => revert.mutate()}
          onClose={() => setReverting(false)}
        />
      )}
    </div>
  )
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="muted" style={{ width: 170, flexShrink: 0 }}>
        {label}
      </span>
      <span className={`truncate${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  )
}
