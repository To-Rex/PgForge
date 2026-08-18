import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, History, Play, Plus, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExplainResponse, QueryHistoryEntry, SqlResponse } from '@pgforge/shared'
import { DbSwitcher } from '../../components/layout/DbSwitcher.js'
import { PathBar } from '../../components/layout/PathBar.js'
import { Button, EmptyState } from '../../components/ui/basics.js'
import { Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { formatDate, formatMs, newExecId } from '../../lib/format.js'
import { useAutocomplete } from '../../lib/queries.js'
import { takePendingSql } from '../../lib/sql-handoff.js'
import { toast } from '../../stores/toast.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'
import { ResultsPanel } from './ResultsPanel.js'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor.js'

interface EditorTab {
  id: string
  title: string
  sql: string
}

function loadTabs(connId: string): { tabs: EditorTab[]; active: string } {
  try {
    const raw = localStorage.getItem(`pgforge.sqltabs.${connId}`)
    if (raw) {
      const parsed = JSON.parse(raw) as { tabs: EditorTab[]; active: string }
      if (parsed.tabs.length > 0) return parsed
    }
  } catch {
    /* corrupted state falls through to default */
  }
  const tab = { id: newExecId(), title: 'query 1', sql: '' }
  return { tabs: [tab], active: tab.id }
}

export function SqlPage() {
  const { t } = useTranslation()
  const { connId, connection, db, setDb } = useWorkspace()
  const queryClient = useQueryClient()
  const [state, setState] = useState(() => loadTabs(connId))
  const [response, setResponse] = useState<SqlResponse | null>(null)
  const [runningExecId, setRunningExecId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [explain, setExplain] = useState<ExplainResponse | null>(null)
  const editorRef = useRef<SqlEditorHandle | null>(null)

  const autocomplete = useAutocomplete(connId, db)
  const activeTab = state.tabs.find((tab) => tab.id === state.active) ?? state.tabs[0]!

  useEffect(() => {
    try {
      localStorage.setItem(`pgforge.sqltabs.${connId}`, JSON.stringify(state))
    } catch {
      /* quota exceeded — tabs simply won't persist */
    }
  }, [state, connId])

  // Pick up SQL handed off from the explorer (new function/view templates,
  // "open in SQL editor"). One-shot: the stash clears itself on read.
  useEffect(() => {
    const pending = takePendingSql()
    if (pending) {
      const tab = { id: newExecId(), title: `query ${state.tabs.length + 1}`, sql: pending }
      setState((prev) => ({ tabs: [...prev.tabs, tab], active: tab.id }))
      setResponse(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateTabSql = useCallback(
    (sql: string) => {
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => (tab.id === prev.active ? { ...tab, sql } : tab)),
      }))
    },
    [],
  )

  const execute = useMutation({
    mutationFn: async (sqlText: string) => {
      const execId = newExecId()
      setRunningExecId(execId)
      return api<SqlResponse>(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/sql/execute`,
        { body: { sql: sqlText, execId } },
      )
    },
    onSuccess: (data) => {
      setResponse(data)
      void queryClient.invalidateQueries({ queryKey: ['history-list'] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
    onSettled: () => setRunningExecId(null),
  })

  const explainQuery = useMutation({
    mutationFn: (input: { sql: string; analyze: boolean }) =>
      api<ExplainResponse>(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/sql/explain`,
        { body: input },
      ),
    onSuccess: setExplain,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const run = useCallback(() => {
    const handle = editorRef.current
    if (!handle || execute.isPending) return
    const text = handle.getSelection() || handle.getText()
    if (!text.trim()) return
    execute.mutate(text)
  }, [execute])

  const cancel = async () => {
    if (!runningExecId) return
    await api(`/api/connections/${connId}/sql/cancel`, { body: { execId: runningExecId } }).catch(
      () => {},
    )
  }

  const addTab = () => {
    const tab = { id: newExecId(), title: `query ${state.tabs.length + 1}`, sql: '' }
    setState((prev) => ({ tabs: [...prev.tabs, tab], active: tab.id }))
    setResponse(null)
  }

  const closeTab = (id: string) => {
    setState((prev) => {
      const tabs = prev.tabs.filter((tab) => tab.id !== id)
      if (tabs.length === 0) {
        const tab = { id: newExecId(), title: 'query 1', sql: '' }
        return { tabs: [tab], active: tab.id }
      }
      return { tabs, active: prev.active === id ? tabs[tabs.length - 1]!.id : prev.active }
    })
  }

  const switchTab = (id: string) => {
    setState((prev) => ({ ...prev, active: id }))
    setResponse(null)
  }

  const loadFromHistory = (entry: QueryHistoryEntry) => {
    editorRef.current?.setText(entry.sql)
    updateTabSql(entry.sql)
    setHistoryOpen(false)
  }

  return (
    <>
      <PathBar
        segments={[
          { kind: 'conn', label: connection.name },
          { kind: 'db', label: db },
          { kind: 'object', label: 'sql' },
        ]}
        actions={<DbSwitcher connId={connId} db={db} onChange={setDb} />}
      />
      <div className="sql-workspace">
        <div className="sql-editor-pane">
          <div className="sql-tabs">
            {state.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`sql-tab${tab.id === state.active ? ' active' : ''}`}
                onClick={() => switchTab(tab.id)}
              >
                {tab.title}
                {state.tabs.length > 1 && (
                  <span
                    className="close"
                    role="button"
                    aria-label={t('common.close')}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                  >
                    <X size={11} />
                  </span>
                )}
              </button>
            ))}
            <button type="button" className="sql-tab" onClick={addTab} aria-label={t('sql.newTab')}>
              <Plus size={12} />
            </button>
          </div>
          <div className="sql-toolbar">
            <Button variant="primary" size="sm" icon={Play} loading={execute.isPending} onClick={run}>
              {t('sql.run')} <kbd>⌘⏎</kbd>
            </Button>
            {execute.isPending && (
              <Button size="sm" variant="danger-outline" icon={Ban} onClick={() => void cancel()}>
                {t('sql.cancel')}
              </Button>
            )}
            <Button
              size="sm"
              icon={Sparkles}
              loading={explainQuery.isPending}
              onClick={() => {
                const handle = editorRef.current
                const text = handle?.getSelection() || handle?.getText()
                if (text?.trim()) explainQuery.mutate({ sql: text, analyze: false })
              }}
            >
              {t('sql.explain')}
            </Button>
            <span className="grow" />
            <Button
              size="sm"
              variant={historyOpen ? 'primary' : 'outline'}
              icon={History}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              {t('sql.history')}
            </Button>
          </div>
          <SqlEditor
            key={activeTab.id}
            initialText={activeTab.sql}
            autocompleteData={autocomplete.data}
            onChange={updateTabSql}
            onRun={run}
            handleRef={(handle) => (editorRef.current = handle)}
            placeholderText={t('sql.editorPlaceholder')}
          />
        </div>
        <div className="sql-results" style={{ flexDirection: 'row', display: 'flex' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <ResultsPanel response={response} running={execute.isPending} />
          </div>
          {historyOpen && <HistoryPane connId={connId} onPick={loadFromHistory} />}
        </div>
      </div>
      {explain && (
        <Modal title={t('sql.plan')} onClose={() => setExplain(null)} wide>
          <pre className="log-view" style={{ maxHeight: '60vh' }}>
            {JSON.stringify(explain.plan, null, 2)}
          </pre>
        </Modal>
      )}
    </>
  )
}

function HistoryPane({
  connId,
  onPick,
}: {
  connId: string
  onPick: (entry: QueryHistoryEntry) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const history = useQuery({
    queryKey: ['history-list', connId],
    queryFn: () => api<QueryHistoryEntry[]>(`/api/history?connectionId=${connId}&limit=100`),
  })

  const clear = useMutation({
    mutationFn: () => api('/api/history', { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['history-list'] }),
  })

  return (
    <div
      style={{
        width: 300,
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--surface)',
      }}
    >
      <div className="panel-header" style={{ borderBottom: '1px solid var(--border)' }}>
        {t('sql.history')}
        <Button size="sm" variant="ghost" onClick={() => clear.mutate()}>
          {t('common.clear')}
        </Button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {history.data?.length === 0 && (
          <EmptyState title={t('sql.historyEmpty')} />
        )}
        {history.data?.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onPick(entry)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              borderBottom: '1px solid var(--border)',
              background: 'none',
              padding: '8px 12px',
              cursor: 'pointer',
            }}
          >
            <div
              className="mono truncate"
              style={{ fontSize: 'var(--text-xs)', color: entry.ok ? 'var(--text)' : 'var(--danger)' }}
            >
              {entry.sql}
            </div>
            <div className="faint mono" style={{ fontSize: 10, marginTop: 2 }}>
              {formatDate(entry.executedAt)} · {formatMs(entry.durationMs)} · {entry.database}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
