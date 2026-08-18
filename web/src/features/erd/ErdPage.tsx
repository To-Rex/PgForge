import { useQuery } from '@tanstack/react-query'
import { Maximize2, Network } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type WheelEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ErdGraph } from '@pgforge/shared'
import { DbSwitcher } from '../../components/layout/DbSwitcher.js'
import { PathBar } from '../../components/layout/PathBar.js'
import { Button, EmptyState, Select } from '../../components/ui/basics.js'
import { api } from '../../lib/api.js'
import { useSchemas } from '../../lib/queries.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'

const NODE_W = 220
const ROW_H = 17
const HEADER_H = 30
const PAD_X = 60
const PAD_Y = 40
const MAX_COLS_SHOWN = 14

interface NodePos {
  x: number
  y: number
}

const nodeHeight = (columnCount: number) =>
  HEADER_H + Math.min(columnCount, MAX_COLS_SHOWN + 1) * ROW_H + 8

export function ErdPage() {
  const { t } = useTranslation()
  const { connId, connection, db, setDb } = useWorkspace()
  const schemas = useSchemas(connId, db)
  const [schema, setSchema] = useState('public')

  useEffect(() => {
    if (schemas.data && !schemas.data.some((s) => s.name === schema)) {
      setSchema(schemas.data[0]?.name ?? 'public')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas.data])

  const graph = useQuery({
    queryKey: ['erd', connId, db, schema],
    queryFn: () =>
      api<ErdGraph>(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/erd?schema=${encodeURIComponent(schema)}`,
      ),
  })

  return (
    <>
      <PathBar
        segments={[
          { kind: 'conn', label: connection.name },
          { kind: 'db', label: db },
          { kind: 'schema', label: schema },
          { kind: 'object', label: 'erd' },
        ]}
        actions={
          <>
            <Select
              className="mono"
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              style={{ width: 'auto', height: 26, fontSize: 'var(--text-xs)' }}
              aria-label={t('erd.schema')}
            >
              {schemas.data?.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>
            <DbSwitcher connId={connId} db={db} onChange={setDb} />
          </>
        }
      />
      {graph.data && graph.data.tables.length === 0 ? (
        <EmptyState icon={Network} title={t('erd.empty')} />
      ) : graph.data ? (
        <ErdCanvas key={`${db}.${schema}`} graph={graph.data} hint={t('erd.hint')} fitLabel={t('erd.fit')} />
      ) : (
        <div className="row" style={{ flex: 1, justifyContent: 'center' }}>
          <span className="spinner" />
        </div>
      )}
    </>
  )
}

function autoLayout(graph: ErdGraph): Map<string, NodePos> {
  const positions = new Map<string, NodePos>()
  const count = graph.tables.length
  const perRow = Math.max(1, Math.ceil(Math.sqrt(count * 1.4)))
  let x = PAD_X
  let y = PAD_Y
  let rowMaxH = 0
  graph.tables.forEach((table, i) => {
    if (i > 0 && i % perRow === 0) {
      x = PAD_X
      y += rowMaxH + PAD_Y
      rowMaxH = 0
    }
    positions.set(`${table.schema}.${table.name}`, { x, y })
    rowMaxH = Math.max(rowMaxH, nodeHeight(table.columns.length))
    x += NODE_W + PAD_X
  })
  return positions
}

function ErdCanvas({ graph, hint, fitLabel }: { graph: ErdGraph; hint: string; fitLabel: string }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [positions, setPositions] = useState(() => autoLayout(graph))
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
  const dragState = useRef<
    | { mode: 'node'; key: string; startX: number; startY: number; origin: NodePos }
    | { mode: 'pan'; startX: number; startY: number; origin: { x: number; y: number } }
    | null
  >(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)

  const fit = () => {
    const host = svgRef.current?.parentElement
    if (!host || positions.size === 0) return
    let maxX = 0
    let maxY = 0
    for (const [key, pos] of positions) {
      const table = graph.tables.find((t) => `${t.schema}.${t.name}` === key)
      maxX = Math.max(maxX, pos.x + NODE_W)
      maxY = Math.max(maxY, pos.y + nodeHeight(table?.columns.length ?? 1))
    }
    const scale = Math.min(host.clientWidth / (maxX + PAD_X), host.clientHeight / (maxY + PAD_Y), 1.2)
    setView({ x: 0, y: 0, scale: Math.max(scale, 0.15) })
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fit, [])

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale,
    }
  }

  const onWheel = (e: WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    const rect = svgRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setView((v) => {
      const scale = Math.min(Math.max(v.scale * factor, 0.1), 2.5)
      // Zoom around the cursor.
      const wx = (mx - v.x) / v.scale
      const wy = (my - v.y) / v.scale
      return { scale, x: mx - wx * scale, y: my - wy * scale }
    })
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragState.current
      if (!drag) return
      if (drag.mode === 'pan') {
        setView((v) => ({
          ...v,
          x: drag.origin.x + (e.clientX - drag.startX),
          y: drag.origin.y + (e.clientY - drag.startY),
        }))
      } else {
        const dx = (e.clientX - drag.startX) / view.scale
        const dy = (e.clientY - drag.startY) / view.scale
        setPositions((prev) => {
          const next = new Map(prev)
          next.set(drag.key, { x: drag.origin.x + dx, y: drag.origin.y + dy })
          return next
        })
      }
    }
    const onUp = () => {
      dragState.current = null
      setDraggingKey(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [view.scale])

  const edges = useMemo(() => {
    return graph.relations
      .map((rel) => {
        const fromKey = `${rel.fromSchema}.${rel.fromTable}`
        const toKey = `${rel.toSchema}.${rel.toTable}`
        const from = positions.get(fromKey)
        const to = positions.get(toKey)
        const fromTable = graph.tables.find((t) => `${t.schema}.${t.name}` === fromKey)
        const toTable = graph.tables.find((t) => `${t.schema}.${t.name}` === toKey)
        if (!from || !to || !fromTable || !toTable) return null
        const fromColIdx = Math.min(
          Math.max(fromTable.columns.findIndex((c) => c.name === rel.fromColumns[0]), 0),
          MAX_COLS_SHOWN,
        )
        const toColIdx = Math.min(
          Math.max(toTable.columns.findIndex((c) => c.name === rel.toColumns[0]), 0),
          MAX_COLS_SHOWN,
        )
        const y1 = from.y + HEADER_H + fromColIdx * ROW_H + ROW_H / 2
        const y2 = to.y + HEADER_H + toColIdx * ROW_H + ROW_H / 2
        const fromRight = from.x + NODE_W <= to.x
        const x1 = fromRight ? from.x + NODE_W : from.x
        const x2 = fromRight ? to.x : to.x + NODE_W
        const dx = Math.max(Math.abs(x2 - x1) / 2, 40) * (fromRight ? 1 : -1)
        return {
          id: rel.id,
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        }
      })
      .filter((e): e is { id: string; d: string } => e !== null)
  }, [graph, positions])

  return (
    <div className={`erd-canvas${dragState.current?.mode === 'pan' ? ' panning' : ''}`}>
      <div style={{ position: 'absolute', top: 10, right: 12, zIndex: 5 }} className="row">
        <span className="faint" style={{ fontSize: 'var(--text-xs)' }}>{hint}</span>
        <Button size="sm" icon={Maximize2} onClick={fit}>
          {fitLabel}
        </Button>
      </div>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (e.target === svgRef.current) {
            dragState.current = {
              mode: 'pan',
              startX: e.clientX,
              startY: e.clientY,
              origin: { x: view.x, y: view.y },
            }
          }
        }}
        role="img"
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {edges.map((edge) => (
            <path key={edge.id} className="erd-edge" d={edge.d} />
          ))}
          {graph.tables.map((table) => {
            const key = `${table.schema}.${table.name}`
            const pos = positions.get(key)
            if (!pos) return null
            const shown = table.columns.slice(0, MAX_COLS_SHOWN)
            const extra = table.columns.length - shown.length
            return (
              <g
                key={key}
                className={`erd-table${draggingKey === key ? ' dragging' : ''}`}
                transform={`translate(${pos.x} ${pos.y})`}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  const world = toWorld(e.clientX, e.clientY)
                  void world
                  dragState.current = {
                    mode: 'node',
                    key,
                    startX: e.clientX,
                    startY: e.clientY,
                    origin: pos,
                  }
                  setDraggingKey(key)
                }}
                style={{ cursor: 'move' }}
              >
                <rect className="erd-table-box" width={NODE_W} height={nodeHeight(table.columns.length)} rx={6} />
                <text className="erd-title" x={10} y={19}>
                  {table.name}
                </text>
                <line x1={0} y1={HEADER_H - 4} x2={NODE_W} y2={HEADER_H - 4} stroke="var(--border)" />
                {shown.map((col, i) => (
                  <g key={col.name}>
                    <text className={`erd-col${col.pk ? ' pk' : ''}`} x={10} y={HEADER_H + 9 + i * ROW_H}>
                      {col.pk ? '⚷ ' : col.fk ? '→ ' : ''}
                      {col.name.length > 18 ? `${col.name.slice(0, 17)}…` : col.name}
                    </text>
                    <text className="erd-col-type" x={NODE_W - 10} y={HEADER_H + 9 + i * ROW_H} textAnchor="end">
                      {col.type.length > 12 ? `${col.type.slice(0, 11)}…` : col.type}
                    </text>
                  </g>
                ))}
                {extra > 0 && (
                  <text className="erd-col-type" x={10} y={HEADER_H + 9 + shown.length * ROW_H}>
                    +{extra}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
