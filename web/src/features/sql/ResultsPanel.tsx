import { Terminal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SqlResponse, StatementResult } from '@pgforge/shared'
import { EmptyState } from '../../components/ui/basics.js'
import { Tabs } from '../../components/ui/Tabs.js'
import { displayValue, formatCount, formatMs } from '../../lib/format.js'

export function ResultsPanel({
  response,
  running,
}: {
  response: SqlResponse | null
  running: boolean
}) {
  const { t } = useTranslation()
  const [activeIdx, setActiveIdx] = useState(0)

  if (running) {
    return (
      <div className="row" style={{ flex: 1, justifyContent: 'center' }}>
        <span className="spinner" />
      </div>
    )
  }
  if (!response) {
    return <EmptyState icon={Terminal} title={t('sql.noResults')} />
  }

  const withRows = response.results
  const active = withRows[Math.min(activeIdx, withRows.length - 1)]

  return (
    <>
      <div className="sql-status">
        <span style={{ color: response.ok ? 'var(--ok)' : 'var(--danger)' }}>
          {response.ok ? '✓' : '✗'}
        </span>
        <span>{formatMs(response.totalDurationMs)}</span>
        {response.results.map((result, i) => (
          <span key={i}>
            {result.command} {result.rowCount !== null ? formatCount(result.rowCount) : ''}
          </span>
        ))}
        {response.notices.length > 0 && (
          <span title={response.notices.join('\n')} style={{ color: 'var(--warn)' }}>
            {t('sql.notices')}: {response.notices.length}
          </span>
        )}
      </div>

      {response.error && (
        <div className="sql-error">
          {response.error.message}
          {response.error.detail ? `\n${response.error.detail}` : ''}
          {response.error.hint ? `\nHint: ${response.error.hint}` : ''}
          {response.error.position ? `\n(position ${response.error.position})` : ''}
        </div>
      )}

      {withRows.length > 1 && (
        <Tabs
          tabs={withRows.map((result, i) => ({
            key: String(i),
            label: `${t('sql.statement', { n: i + 1 })} · ${result.command}`,
          }))}
          active={String(Math.min(activeIdx, withRows.length - 1))}
          onChange={(key) => setActiveIdx(Number(key))}
        />
      )}

      {active && <ResultGrid result={active} />}
    </>
  )
}

function ResultGrid({ result }: { result: StatementResult }) {
  const { t } = useTranslation()

  if (result.fields.length === 0) {
    return (
      <div className="sql-status" style={{ borderBottom: 'none' }}>
        <span>
          {result.command} — {t('sql.affected', { count: result.rowCount ?? 0 })} ·{' '}
          {formatMs(result.durationMs)}
        </span>
      </div>
    )
  }

  return (
    <>
      <div className="grid-wrap">
        <table className="data-grid">
          <thead>
            <tr>
              <th style={{ width: 44 }}>
                <div className="col-head faint">#</div>
              </th>
              {result.fields.map((field, i) => (
                <th key={i}>
                  <div className="col-head" style={{ cursor: 'default' }}>
                    <span>{field.name}</span>
                    <span className="col-type">{field.dataType}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                <td className="faint" style={{ textAlign: 'right' }}>
                  {rowIdx + 1}
                </td>
                {row.map((value, colIdx) => (
                  <td key={colIdx} className={value === null ? 'null' : ''} title={displayValue(value)}>
                    {value === null ? 'NULL' : displayValue(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid-footer">
        <span className="mono">
          {t('sql.rowsReturned', { count: result.rowCount ?? result.rows.length })}
          {result.truncated ? ` — ${t('sql.truncatedNote', { max: result.rows.length })}` : ''}
        </span>
        <span className="mono">{formatMs(result.durationMs)}</span>
      </div>
    </>
  )
}
