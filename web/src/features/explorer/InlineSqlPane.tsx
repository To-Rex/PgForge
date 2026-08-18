import { useMutation } from '@tanstack/react-query'
import { Ban, Play } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SqlResponse } from '@pgforge/shared'
import { Button } from '../../components/ui/basics.js'
import { api, ApiError } from '../../lib/api.js'
import { newExecId } from '../../lib/format.js'
import { useAutocomplete } from '../../lib/queries.js'
import { toast } from '../../stores/toast.js'
import { ResultsPanel } from '../sql/ResultsPanel.js'
import { SqlEditor, type SqlEditorHandle } from '../sql/SqlEditor.js'

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Per-table drafts survive tab/table switches within the session. */
const drafts = new Map<string, string>()

/**
 * A lean SQL editor embedded next to the Data/Structure tabs — query the
 * selected table without leaving the explorer. The full SQL page still
 * offers tabs, history and EXPLAIN.
 */
export function InlineSqlPane({
  connId,
  db,
  schema,
  table,
}: {
  connId: string
  db: string
  schema: string
  table: string
}) {
  const { t } = useTranslation()
  const draftKey = `${connId}/${db}/${schema}.${table}`
  const initialSql =
    drafts.get(draftKey) ?? `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 100;`
  const editorRef = useRef<SqlEditorHandle | null>(null)
  const [response, setResponse] = useState<SqlResponse | null>(null)
  const [runningExecId, setRunningExecId] = useState<string | null>(null)
  const autocomplete = useAutocomplete(connId, db)

  const execute = useMutation({
    mutationFn: async (sqlText: string) => {
      const execId = newExecId()
      setRunningExecId(execId)
      return api<SqlResponse>(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/sql/execute`,
        { body: { sql: sqlText, execId } },
      )
    },
    onSuccess: setResponse,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
    onSettled: () => setRunningExecId(null),
  })

  const run = useCallback(() => {
    const handle = editorRef.current
    if (!handle || execute.isPending) return
    const text = handle.getSelection() || handle.getText()
    if (text.trim()) execute.mutate(text)
  }, [execute])

  const cancel = async () => {
    if (!runningExecId) return
    await api(`/api/connections/${connId}/sql/cancel`, { body: { execId: runningExecId } }).catch(
      () => {},
    )
  }

  return (
    <div className="sql-workspace">
      <div className="sql-editor-pane" style={{ height: '38%' }}>
        <div className="sql-toolbar">
          <Button variant="primary" size="sm" icon={Play} loading={execute.isPending} onClick={run}>
            {t('sql.run')} <kbd>⌘⏎</kbd>
          </Button>
          {execute.isPending && (
            <Button size="sm" variant="danger-outline" icon={Ban} onClick={() => void cancel()}>
              {t('sql.cancel')}
            </Button>
          )}
        </div>
        <SqlEditor
          key={draftKey}
          initialText={initialSql}
          autocompleteData={autocomplete.data}
          onChange={(text) => drafts.set(draftKey, text)}
          onRun={run}
          handleRef={(handle) => (editorRef.current = handle)}
          placeholderText={t('sql.editorPlaceholder')}
        />
      </div>
      <div className="sql-results">
        <ResultsPanel response={response} running={execute.isPending} />
      </div>
    </div>
  )
}
