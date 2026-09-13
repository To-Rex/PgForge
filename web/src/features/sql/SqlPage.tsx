import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, BookMarked, Gauge, History, Pencil, Play, Plus, Save, Sparkles, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExplainResponse, QueryHistoryEntry, SavedQuery, SqlResponse } from '@pgforge/shared'
import { DbSwitcher } from '../../components/layout/DbSwitcher.js'
import { PathBar } from '../../components/layout/PathBar.js'
import { Badge, Button, Checkbox, EmptyState, Field, TextInput } from '../../components/ui/basics.js'
import { ConfirmDialog, Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { formatDate, formatMs, newExecId } from '../../lib/format.js'
import { useAutocomplete, useSavedQueries } from '../../lib/queries.js'
import { looksReadOnly } from '../../lib/sql-kind.js'
import { takePendingSql } from '../../lib/sql-handoff.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'
import { PlanView } from './PlanView.js'
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
  const [sidePane, setSidePane] = useState<'history' | 'saved' | null>(null)
  const [explain, setExplain] = useState<ExplainResponse | null>(null)
  const [savingQuery, setSavingQuery] = useState(false)
  // EXPLAIN ANALYZE really runs the statement, so a write needs a deliberate yes.
  const [confirmAnalyze, setConfirmAnalyze] = useState<string | null>(null)
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

  /** Current statement: the selection if there is one, else the whole tab. */
  const currentSql = () => {
    const handle = editorRef.current
    return (handle?.getSelection() || handle?.getText() || '').trim()
  }

  const runExplain = (analyze: boolean) => {
    const text = currentSql()
    if (!text) return
    if (analyze && !looksReadOnly(text)) {
      setConfirmAnalyze(text)
      return
    }
    explainQuery.mutate({ sql: text, analyze })
  }

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

  const loadSql = (sql: string) => {
    editorRef.current?.setText(sql)
    updateTabSql(sql)
  }

  const loadFromHistory = (entry: QueryHistoryEntry) => {
    loadSql(entry.sql)
    setSidePane(null)
  }

  const togglePane = (pane: 'history' | 'saved') =>
    setSidePane((current) => (current === pane ? null : pane))

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
              loading={explainQuery.isPending && !explainQuery.variables?.analyze}
              onClick={() => runExplain(false)}
            >
              {t('sql.explain')}
            </Button>
            <Button
              size="sm"
              icon={Gauge}
              loading={explainQuery.isPending && explainQuery.variables?.analyze === true}
              onClick={() => runExplain(true)}
              title={t('sql.explainAnalyzeHint')}
            >
              {t('sql.explainAnalyze')}
            </Button>
            <span className="grow" />
            <Button
              size="sm"
              icon={Save}
              disabled={!activeTab.sql.trim()}
              onClick={() => setSavingQuery(true)}
            >
              {t('sql.save')}
            </Button>
            <Button
              size="sm"
              variant={sidePane === 'saved' ? 'primary' : 'outline'}
              icon={BookMarked}
              onClick={() => togglePane('saved')}
            >
              {t('sql.saved')}
            </Button>
            <Button
              size="sm"
              variant={sidePane === 'history' ? 'primary' : 'outline'}
              icon={History}
              onClick={() => togglePane('history')}
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
          {sidePane === 'history' && <HistoryPane connId={connId} onPick={loadFromHistory} />}
          {sidePane === 'saved' && (
            <SavedPane
              connId={connId}
              onPick={(query) => {
                loadSql(query.sql)
                setSidePane(null)
              }}
            />
          )}
        </div>
      </div>
      {explain && (
        <Modal title={t('sql.plan')} onClose={() => setExplain(null)} wide>
          <PlanView response={explain} />
        </Modal>
      )}
      {confirmAnalyze && (
        <ConfirmDialog
          title={t('sql.explainAnalyze')}
          message={t('sql.explainAnalyzeWarning')}
          confirmLabel={t('sql.explainAnalyzeRun')}
          loading={explainQuery.isPending}
          onConfirm={() => {
            explainQuery.mutate({ sql: confirmAnalyze, analyze: true })
            setConfirmAnalyze(null)
          }}
          onClose={() => setConfirmAnalyze(null)}
        />
      )}
      {savingQuery && (
        <SaveQueryDialog
          connId={connId}
          sql={activeTab.sql}
          suggestedName={activeTab.title}
          onClose={() => setSavingQuery(false)}
          onSaved={() => {
            setSavingQuery(false)
            setSidePane('saved')
          }}
        />
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
    <div className="side-pane">
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

/**
 * Saved snippets: what history cannot be. History is a rolling log that prunes
 * itself; these are named, editable, and kept until deleted — and optionally
 * shared, so a team's useful queries stop living in someone's scratch file.
 */
function SavedPane({
  connId,
  onPick,
}: {
  connId: string
  onPick: (query: SavedQuery) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const saved = useSavedQueries(connId)
  const [deleting, setDeleting] = useState<SavedQuery | null>(null)
  const [editing, setEditing] = useState<SavedQuery | null>(null)

  const remove = useMutation({
    mutationFn: (query: SavedQuery) =>
      api(`/api/saved-queries/${query.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-queries'] })
      setDeleting(null)
      toast.ok(t('common.success'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <div className="side-pane">
      <div className="panel-header" style={{ borderBottom: '1px solid var(--border)' }}>
        {t('sql.saved')}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {saved.isLoading && (
          <div className="row" style={{ padding: 16, justifyContent: 'center' }}>
            <span className="spinner" />
          </div>
        )}
        {saved.data?.length === 0 && <EmptyState title={t('sql.savedEmpty')} hint={t('sql.savedHint')} />}
        {saved.data?.map((query) => (
          <div key={query.id} className="saved-item">
            <button type="button" className="saved-open" onClick={() => onPick(query)}>
              <div className="row" style={{ gap: 6 }}>
                <span className="truncate grow" style={{ fontSize: 'var(--text-sm)' }}>
                  {query.name}
                </span>
                {query.shared && <Badge kind="muted">{t('sql.shared')}</Badge>}
              </div>
              {query.description && <div className="faint truncate">{query.description}</div>}
              <div className="mono truncate faint" style={{ fontSize: 10, marginTop: 2 }}>
                {query.sql}
              </div>
            </button>
            {(query.ownerId === user?.id || user?.role === 'admin') && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Pencil}
                  aria-label={t('common.edit')}
                  onClick={() => setEditing(query)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  aria-label={t('common.delete')}
                  onClick={() => setDeleting(query)}
                />
              </>
            )}
          </div>
        ))}
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('common.delete')}
          message={deleting.name}
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
      {editing && (
        <SaveQueryDialog
          connId={connId}
          sql={editing.sql}
          suggestedName={editing.name}
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function SaveQueryDialog({
  connId,
  sql,
  suggestedName,
  existing,
  onClose,
  onSaved,
}: {
  connId: string
  sql: string
  suggestedName: string
  /** Present when renaming/re-scoping an existing snippet rather than creating one. */
  existing?: SavedQuery
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const [name, setName] = useState(suggestedName)
  const [description, setDescription] = useState(existing?.description ?? '')
  const [shared, setShared] = useState(existing?.shared ?? false)
  const [pinned, setPinned] = useState(existing ? existing.connectionId !== null : true)

  const create = useMutation({
    mutationFn: () =>
      api(existing ? `/api/saved-queries/${existing.id}` : '/api/saved-queries', {
        method: existing ? 'PATCH' : 'POST',
        body: {
          name,
          description: description || null,
          sql,
          connectionId: pinned ? connId : null,
          shared,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-queries'] })
      toast.ok(t('common.success'))
      onSaved()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={existing ? t('common.edit') : t('sql.save')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')}>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label={t('common.description')}>
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Checkbox label={t('sql.pinToConnection')} checked={pinned} onChange={setPinned} />
      {user?.role !== 'viewer' && (
        <Checkbox label={t('sql.shareWithTeam')} checked={shared} onChange={setShared} />
      )}
    </Modal>
  )
}
