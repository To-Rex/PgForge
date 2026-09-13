import { AlertTriangle, Braces, ListTree } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExplainResponse } from '@pgforge/shared'
import { Badge, Button } from '../../components/ui/basics.js'
import { formatCount, formatMs } from '../../lib/format.js'
import { flattenPlan, hottestNodes, parsePlan, type PlanNode, type PlanWarning } from './plan.js'

const WARNING_KEY: Record<PlanWarning, string> = {
  row_misestimate: 'plan.warnMisestimate',
  heavy_filter: 'plan.warnHeavyFilter',
  seq_scan: 'plan.warnSeqScan',
  external_sort: 'plan.warnExternalSort',
}

function ratioLabel(ratio: number): string {
  if (ratio >= 1) return `${ratio >= 100 ? Math.round(ratio) : ratio.toFixed(1)}× more`
  return `${(1 / ratio >= 100 ? Math.round(1 / ratio) : (1 / ratio).toFixed(1))}× fewer`
}

export function PlanView({ response }: { response: ExplainResponse }) {
  const { t } = useTranslation()
  const [raw, setRaw] = useState(false)
  const parsed = useMemo(() => parsePlan(response.plan), [response.plan])

  if (!parsed) {
    return (
      <pre className="log-view" style={{ maxHeight: '60vh' }}>
        {JSON.stringify(response.plan, null, 2)}
      </pre>
    )
  }

  const rows = flattenPlan(parsed.root)
  const hot = hottestNodes(parsed.root)

  return (
    <div className="plan-view">
      <div className="plan-summary">
        {parsed.analyzed ? (
          <>
            <span>
              {t('plan.execution')} <strong>{formatMs(parsed.executionMs)}</strong>
            </span>
            <span>
              {t('plan.planning')} <strong>{formatMs(parsed.planningMs)}</strong>
            </span>
          </>
        ) : (
          <span className="muted">{t('plan.estimateOnly')}</span>
        )}
        <span>
          {t('plan.cost')} <strong>{Math.round(parsed.totalCost).toLocaleString()}</strong>
        </span>
        <span>
          {t('plan.nodes')} <strong>{parsed.nodeCount}</strong>
        </span>
        <span className="grow" />
        <Button
          size="sm"
          variant="ghost"
          icon={raw ? ListTree : Braces}
          onClick={() => setRaw((v) => !v)}
        >
          {raw ? t('plan.tree') : 'JSON'}
        </Button>
      </div>

      {raw ? (
        <pre className="log-view" style={{ maxHeight: '52vh' }}>
          {JSON.stringify(response.plan, null, 2)}
        </pre>
      ) : (
        <>
          {parsed.analyzed && hot.length > 0 && (
            <div className="plan-hot">
              <span className="plan-hot-label">{t('plan.hottest')}</span>
              {hot.map((node) => (
                <span key={node.id} className="plan-hot-item mono">
                  {node.label} · {formatMs(node.selfMs)}
                </span>
              ))}
            </div>
          )}
          <div className="plan-rows">
            {rows.map(({ node, depth }) => (
              <PlanRow
                key={node.id}
                node={node}
                depth={depth}
                maxSelfMs={parsed.maxSelfMs}
                analyzed={parsed.analyzed}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function PlanRow({
  node,
  depth,
  maxSelfMs,
  analyzed,
}: {
  node: PlanNode
  depth: number
  maxSelfMs: number
  analyzed: boolean
}) {
  const { t } = useTranslation()
  // Share of the slowest node, so the widest bar is always the one to look at.
  const share = analyzed && maxSelfMs > 0 ? ((node.selfMs ?? 0) / maxSelfMs) * 100 : 0
  const misestimated = node.warnings.includes('row_misestimate')

  return (
    <div className="plan-row" style={{ paddingLeft: 8 + depth * 16 }}>
      <div className="plan-bar-track" aria-hidden="true">
        <div
          className={`plan-bar${share > 50 ? ' hot' : ''}`}
          style={{ width: `${Math.max(share, analyzed ? 1 : 0)}%` }}
        />
      </div>
      <div className="plan-row-main">
        <span className="plan-node mono">{node.label}</span>
        {analyzed && <span className="plan-time mono">{formatMs(node.selfMs)}</span>}
        <span className={`plan-rows-count mono${misestimated ? ' bad' : ''}`}>
          {node.actualRows === null
            ? `~${formatCount(node.planRows)}`
            : `${formatCount(node.actualRows)} / ~${formatCount(node.planRows)}`}
          {misestimated && node.rowsRatio !== null && ` (${ratioLabel(node.rowsRatio)})`}
        </span>
        {node.loops > 1 && <span className="plan-loops mono">×{formatCount(node.loops)}</span>}
      </div>
      {node.warnings.length > 0 && (
        <div className="plan-warnings">
          {node.warnings.map((warning) => (
            <Badge key={warning} kind={warning === 'row_misestimate' ? 'warn' : 'muted'}>
              <AlertTriangle size={10} style={{ marginRight: 3, verticalAlign: -1 }} />
              {t(WARNING_KEY[warning])}
            </Badge>
          ))}
        </div>
      )}
      {node.detail.length > 0 && (
        <div className="plan-detail mono">
          {node.detail.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
