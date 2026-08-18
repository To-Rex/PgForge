import { useMutation, useQuery } from '@tanstack/react-query'
import { Ban, OctagonX, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DbStats,
  LockInfo,
  SessionInfo,
  SlowQueriesResponse,
  TableStat,
} from '@pgforge/shared'
import { DbSwitcher } from '../../components/layout/DbSwitcher.js'
import { PathBar } from '../../components/layout/PathBar.js'
import { Badge, Button, EmptyState } from '../../components/ui/basics.js'
import { ConfirmDialog } from '../../components/ui/overlays.js'
import { Tabs } from '../../components/ui/Tabs.js'
import { api, ApiError } from '../../lib/api.js'
import {
  formatBytes,
  formatCount,
  formatDate,
  formatMs,
  formatPercent,
} from '../../lib/format.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'
import { HBars, LineChart } from './charts.js'
import { computeRates, pushSample } from './series-store.js'

type MonitorTab = 'overview' | 'sessions' | 'locks' | 'slow' | 'tables'

export function MonitorPage() {
  const { t } = useTranslation()
  const { connId, connection, db, setDb } = useWorkspace()
  const [tab, setTab] = useState<MonitorTab>('overview')

  return (
    <>
      <PathBar
        segments={[
          { kind: 'conn', label: connection.name },
          { kind: 'db', label: db },
          { kind: 'object', label: 'monitor' },
        ]}
        actions={<DbSwitcher connId={connId} db={db} onChange={setDb} />}
      />
      <div className="page-fill">
        <Tabs<MonitorTab>
          tabs={[
            { key: 'overview', label: t('monitor.overview') },
            { key: 'sessions', label: t('monitor.sessions') },
            { key: 'locks', label: t('monitor.locks') },
            { key: 'slow', label: t('monitor.slow') },
            { key: 'tables', label: t('monitor.tables') },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === 'overview' && <OverviewTab connId={connId} db={db} />}
        {tab === 'sessions' && <SessionsTab connId={connId} />}
        {tab === 'locks' && <LocksTab connId={connId} />}
        {tab === 'slow' && <SlowTab connId={connId} db={db} />}
        {tab === 'tables' && <TablesTab connId={connId} db={db} />}
      </div>
    </>
  )
}

function OverviewTab({ connId, db }: { connId: string; db: string }) {
  const { t } = useTranslation()
  const stats = useQuery({
    queryKey: ['db-stats', connId, db],
    queryFn: () => api<DbStats>(`/api/connections/${connId}/db/${encodeURIComponent(db)}/stats`),
    refetchInterval: 5_000,
  })
  const tableStats = useQuery({
    queryKey: ['table-stats', connId, db],
    queryFn: () => api<TableStat[]>(`/api/connections/${connId}/db/${encodeURIComponent(db)}/table-stats`),
    refetchInterval: 30_000,
  })

  const sampleKey = `${connId}/${db}`
  const rates = useMemo(() => {
    const samples = stats.data ? pushSample(sampleKey, stats.data) : []
    return computeRates(samples)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.data, sampleKey])

  const s = stats.data
  if (!s) {
    return (
      <div className="row" style={{ padding: 24, justifyContent: 'center' }}>
        <span className="spinner" />
      </div>
    )
  }

  const cells: { label: string; value: string }[] = [
    { label: t('monitor.dbSize'), value: formatBytes(s.sizeBytes) },
    { label: t('monitor.cacheHit'), value: formatPercent(s.cacheHitRatio) },
    { label: t('conn.activeConnections'), value: `${s.sessionsTotal} / ${s.maxConnections}` },
    { label: t('monitor.locksCell'), value: `${s.locksTotal} (${s.locksWaiting})` },
    { label: t('monitor.deadlocks'), value: formatCount(s.deadlocks) },
    { label: t('monitor.commits'), value: formatCount(s.commits) },
    { label: t('monitor.rollbacks'), value: formatCount(s.rollbacks) },
    { label: t('monitor.tupIn'), value: formatCount(s.tupInserted) },
    { label: t('monitor.tupUp'), value: formatCount(s.tupUpdated) },
    { label: t('monitor.tempFiles'), value: `${formatCount(s.tempFiles)} · ${formatBytes(s.tempBytes)}` },
  ]

  const intFmt = (v: number) => Math.round(v).toLocaleString()
  const collecting = t('monitor.collecting')

  const stateItems = [
    { label: t('monitor.sActive'), value: s.sessionsActive, color: 'var(--chart-1)', display: String(s.sessionsActive) },
    { label: t('monitor.sIdle'), value: s.sessionsIdle, color: 'var(--chart-2)', display: String(s.sessionsIdle) },
    { label: t('monitor.sIdleTx'), value: s.sessionsIdleInTx, color: 'var(--chart-3)', display: String(s.sessionsIdleInTx) },
    {
      label: t('monitor.sOther'),
      value: Math.max(s.sessionsTotal - s.sessionsActive - s.sessionsIdle - s.sessionsIdleInTx, 0),
      color: 'var(--chart-4)',
      display: String(Math.max(s.sessionsTotal - s.sessionsActive - s.sessionsIdle - s.sessionsIdleInTx, 0)),
    },
  ].filter((item) => item.value > 0 || item.label === t('monitor.sActive'))

  const topTables = (tableStats.data ?? [])
    .slice(0, 8)
    .map((table) => ({
      label: `${table.schema}.${table.name}`,
      value: table.totalBytes,
      display: formatBytes(table.totalBytes),
    }))

  return (
    <div className="page">
      <div className="stat-strip">
        {cells.slice(0, 5).map((cell) => (
          <div key={cell.label} className="stat-cell">
            <div className="stat-label">{cell.label}</div>
            <div className="stat-value">{cell.value}</div>
          </div>
        ))}
      </div>
      <div className="stat-strip">
        {cells.slice(5).map((cell) => (
          <div key={cell.label} className="stat-cell">
            <div className="stat-label">{cell.label}</div>
            <div className="stat-value">{cell.value}</div>
          </div>
        ))}
      </div>

      <div className="chart-grid-layout">
        <LineChart
          title={t('monitor.chartSessions')}
          times={rates.times}
          collectingLabel={collecting}
          formatValue={intFmt}
          series={[
            { name: t('monitor.sTotal'), color: 'var(--chart-1)', values: rates.sessionsTotal },
            { name: t('monitor.sActive'), color: 'var(--chart-2)', values: rates.sessionsActive },
            { name: t('monitor.sIdleTx'), color: 'var(--chart-3)', values: rates.sessionsIdleInTx },
          ]}
        />
        <LineChart
          title={t('monitor.chartTps')}
          times={rates.times}
          collectingLabel={collecting}
          series={[
            { name: 'Commit', color: 'var(--chart-1)', values: rates.commitsPerSec },
            { name: 'Rollback', color: 'var(--chart-2)', values: rates.rollbacksPerSec },
          ]}
        />
        <LineChart
          title={t('monitor.chartRows')}
          times={rates.times}
          collectingLabel={collecting}
          series={[
            { name: 'INSERT', color: 'var(--chart-1)', values: rates.insertedPerSec },
            { name: 'UPDATE', color: 'var(--chart-2)', values: rates.updatedPerSec },
            { name: 'DELETE', color: 'var(--chart-3)', values: rates.deletedPerSec },
          ]}
        />
        <LineChart
          title={t('monitor.chartCache')}
          times={rates.times}
          collectingLabel={collecting}
          fixedMax={100}
          formatValue={(v) => `${Math.round(v)}%`}
          series={[{ name: '%', color: 'var(--chart-1)', values: rates.cacheHitPct }]}
        />
      </div>

      <div className="chart-grid-layout">
        <HBars title={t('monitor.chartState')} items={stateItems} emptyLabel={collecting} />
        <HBars title={t('monitor.chartTopTables')} items={topTables} emptyLabel={collecting} />
      </div>

      <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
        {t('monitor.statsSince')}: <span className="mono">{formatDate(s.statsReset)}</span>
      </div>
    </div>
  )
}

function SessionsTab({ connId }: { connId: string }) {
  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const [terminating, setTerminating] = useState<SessionInfo | null>(null)

  const sessions = useQuery({
    queryKey: ['sessions', connId],
    queryFn: () => api<SessionInfo[]>(`/api/connections/${connId}/sessions`),
    refetchInterval: 5000,
  })

  const signal = useMutation({
    mutationFn: (input: { pid: number; action: 'cancel' | 'terminate' }) =>
      api(`/api/connections/${connId}/sessions/${input.action}`, { body: { pid: input.pid } }),
    onSuccess: () => {
      toast.ok(t('common.success'))
      setTerminating(null)
      void sessions.refetch()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <div className="grid-wrap" style={{ background: 'var(--surface)' }}>
      <table className="table">
        <thead>
          <tr>
            <th className="num">{t('monitor.pid')}</th>
            <th>{t('monitor.user')}</th>
            <th>{t('monitor.database')}</th>
            <th>{t('monitor.state')}</th>
            <th>{t('monitor.waitEvent')}</th>
            <th>{t('monitor.clientAddr')}</th>
            <th className="num">{t('common.duration')}</th>
            <th>{t('monitor.query')}</th>
            <th style={{ width: 70 }} />
          </tr>
        </thead>
        <tbody>
          {sessions.data?.map((session) => (
            <tr key={session.pid}>
              <td className="num">{session.pid}</td>
              <td className="mono">{session.user ?? '—'}</td>
              <td className="mono">{session.database ?? '—'}</td>
              <td>
                <Badge kind={session.state === 'active' ? 'ok' : session.state === 'idle' ? 'muted' : 'warn'}>
                  {session.state ?? '?'}
                </Badge>
              </td>
              <td className="muted">
                {session.waitEvent ? `${session.waitEventType}:${session.waitEvent}` : ''}
              </td>
              <td className="mono muted">{session.clientAddr ?? ''}</td>
              <td className="num">{session.queryDurationMs !== null ? formatMs(session.queryDurationMs) : ''}</td>
              <td className="mono truncate" style={{ maxWidth: 340 }} title={session.query}>
                {session.query}
              </td>
              <td>
                {user?.role !== 'viewer' && (
                  <div className="row" style={{ gap: 2 }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Ban}
                      aria-label={t('monitor.cancelBackend')}
                      onClick={() => signal.mutate({ pid: session.pid, action: 'cancel' })}
                    />
                    {user?.role === 'admin' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={OctagonX}
                        aria-label={t('monitor.terminateBackend')}
                        onClick={() => setTerminating(session)}
                      />
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {terminating && (
        <ConfirmDialog
          title={t('monitor.terminateBackend')}
          message={t('monitor.terminateConfirm', { pid: terminating.pid })}
          loading={signal.isPending}
          onConfirm={() => signal.mutate({ pid: terminating.pid, action: 'terminate' })}
          onClose={() => setTerminating(null)}
        />
      )}
    </div>
  )
}

function LocksTab({ connId }: { connId: string }) {
  const { t } = useTranslation()
  const locks = useQuery({
    queryKey: ['locks', connId],
    queryFn: () => api<LockInfo[]>(`/api/connections/${connId}/locks`),
    refetchInterval: 5000,
  })
  return (
    <div className="grid-wrap" style={{ background: 'var(--surface)' }}>
      <table className="table">
        <thead>
          <tr>
            <th className="num">{t('monitor.pid')}</th>
            <th>{t('monitor.lockType')}</th>
            <th>{t('monitor.relation')}</th>
            <th>{t('monitor.lockMode')}</th>
            <th>{t('common.status')}</th>
            <th>{t('monitor.blockedBy')}</th>
            <th>{t('monitor.query')}</th>
          </tr>
        </thead>
        <tbody>
          {locks.data?.map((lock, i) => (
            <tr key={i}>
              <td className="num">{lock.pid}</td>
              <td className="muted">{lock.lockType}</td>
              <td className="mono">{lock.relation ?? ''}</td>
              <td className="mono muted">{lock.mode}</td>
              <td>
                {lock.granted ? (
                  <Badge kind="ok">{t('monitor.granted')}</Badge>
                ) : (
                  <Badge kind="danger">{t('monitor.waiting')}</Badge>
                )}
              </td>
              <td className="mono">{lock.blockedBy.join(', ')}</td>
              <td className="mono truncate" style={{ maxWidth: 320 }} title={lock.query ?? ''}>
                {lock.query ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SlowTab({ connId, db }: { connId: string; db: string }) {
  const { t } = useTranslation()
  const slow = useQuery({
    queryKey: ['slow-queries', connId, db],
    queryFn: () =>
      api<SlowQueriesResponse>(`/api/connections/${connId}/db/${encodeURIComponent(db)}/slow-queries`),
  })
  if (slow.data && !slow.data.available) {
    return <EmptyState title={t('monitor.slow')} hint={t('monitor.statementsMissing')} />
  }
  return (
    <div className="grid-wrap" style={{ background: 'var(--surface)' }}>
      <table className="table">
        <thead>
          <tr>
            <th>{t('monitor.query')}</th>
            <th className="num">{t('monitor.calls')}</th>
            <th className="num">{t('monitor.meanTime')}</th>
            <th className="num">{t('monitor.maxTime')}</th>
            <th className="num">{t('monitor.totalTime')}</th>
            <th className="num">{t('common.rows')}</th>
            <th className="num">{t('monitor.cacheHit')}</th>
          </tr>
        </thead>
        <tbody>
          {slow.data?.queries.map((query, i) => (
            <tr key={i}>
              <td className="mono truncate" style={{ maxWidth: 480 }} title={query.query}>
                {query.query}
              </td>
              <td className="num">{formatCount(query.calls)}</td>
              <td className="num">{formatMs(query.meanMs)}</td>
              <td className="num">{formatMs(query.maxMs)}</td>
              <td className="num">{formatMs(query.totalMs)}</td>
              <td className="num">{formatCount(query.rows)}</td>
              <td className="num">{formatPercent(query.hitRatio)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TablesTab({ connId, db }: { connId: string; db: string }) {
  const { t } = useTranslation()
  const stats = useQuery({
    queryKey: ['table-stats', connId, db],
    queryFn: () => api<TableStat[]>(`/api/connections/${connId}/db/${encodeURIComponent(db)}/table-stats`),
  })
  return (
    <div className="grid-wrap" style={{ background: 'var(--surface)' }}>
      <div className="row" style={{ padding: '6px 12px' }}>
        <span className="grow" />
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => void stats.refetch()} aria-label={t('common.refresh')} />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th className="num">{t('common.size')}</th>
            <th className="num">{t('monitor.liveTuples')}</th>
            <th className="num">{t('monitor.deadTuples')}</th>
            <th className="num">{t('monitor.seqScans')}</th>
            <th className="num">{t('monitor.idxScans')}</th>
            <th>{t('monitor.lastVacuum')}</th>
            <th>{t('monitor.lastAnalyze')}</th>
          </tr>
        </thead>
        <tbody>
          {stats.data?.map((stat) => (
            <tr key={`${stat.schema}.${stat.name}`}>
              <td className="mono">
                {stat.schema}.{stat.name}
              </td>
              <td className="num">{formatBytes(stat.totalBytes)}</td>
              <td className="num">{formatCount(stat.liveTuples)}</td>
              <td className="num">{formatCount(stat.deadTuples)}</td>
              <td className="num">{formatCount(stat.seqScans)}</td>
              <td className="num">{formatCount(stat.idxScans)}</td>
              <td className="mono muted">
                {formatDate(stat.lastVacuum ?? stat.lastAutovacuum)}
                {!stat.lastVacuum && stat.lastAutovacuum ? ` (${t('monitor.autovacuum')})` : ''}
              </td>
              <td className="mono muted">{formatDate(stat.lastAnalyze)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
