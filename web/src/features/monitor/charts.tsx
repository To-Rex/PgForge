import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Hand-rolled SVG charts wired to the design system: 2px lines, recessive
 * grid, crosshair + tooltip on hover, legend with live values, last-value
 * direct labels (the contrast-relief obligation from palette validation).
 */

export interface ChartSeries {
  name: string
  /** CSS color, e.g. 'var(--chart-1)'. */
  color: string
  values: (number | null)[]
}

const PAD_L = 44
const PAD_R = 52
const PAD_T = 10
const PAD_B = 20

function useElementWidth(): [React.MutableRefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(560)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 80) setWidth(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

const timeLabel = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const m of [1, 2, 5, 10]) {
    if (value <= m * magnitude) return m * magnitude
  }
  return 10 * magnitude
}

export function LineChart({
  title,
  times,
  series,
  height = 150,
  fixedMax,
  formatValue = (v: number) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)),
  collectingLabel,
}: {
  title: string
  times: number[]
  series: ChartSeries[]
  height?: number
  /** e.g. 100 for percentages; otherwise the max is computed and niced. */
  fixedMax?: number
  formatValue?: (v: number) => string
  collectingLabel: string
}) {
  const [hostRef, width] = useElementWidth()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const plotW = Math.max(width - PAD_L - PAD_R, 40)
  const plotH = height - PAD_T - PAD_B

  const maxValue = useMemo(() => {
    if (fixedMax !== undefined) return fixedMax
    let max = 0
    for (const s of series) for (const v of s.values) if (v !== null && v > max) max = v
    return niceMax(max)
  }, [series, fixedMax])

  const x = (i: number) =>
    PAD_L + (times.length <= 1 ? plotW : (i / (times.length - 1)) * plotW)
  const y = (v: number) => PAD_T + plotH - (Math.min(v, maxValue) / maxValue) * plotH

  const paths = useMemo(
    () =>
      series.map((s) => {
        let d = ''
        let pen = false
        s.values.forEach((v, i) => {
          if (v === null) {
            pen = false
            return
          }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
          pen = true
        })
        return d
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, times.length, plotW, plotH, maxValue],
  )

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (times.length < 2) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left - PAD_L
    const idx = Math.round((px / plotW) * (times.length - 1))
    setHoverIdx(Math.min(Math.max(idx, 0), times.length - 1))
  }

  const gridLines = [0, 0.5, 1]
  const lastValue = (s: ChartSeries): number | null => {
    for (let i = s.values.length - 1; i >= 0; i--) {
      if (s.values[i] !== null) return s.values[i]
    }
    return null
  }

  const hover = hoverIdx !== null && times[hoverIdx] !== undefined ? hoverIdx : null
  const tooltipLeft = hover !== null ? x(hover) : 0
  const flipTooltip = tooltipLeft > width - 150

  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      <div ref={hostRef} style={{ position: 'relative' }}>
        {times.length < 2 ? (
          <div className="chart-empty" style={{ height }}>
            <span className="spinner" />
            {collectingLabel}
          </div>
        ) : (
          <svg
            width={width}
            height={height}
            onMouseMove={onMove}
            onMouseLeave={() => setHoverIdx(null)}
            role="img"
            aria-label={title}
          >
            {gridLines.map((g) => {
              const gy = PAD_T + plotH - g * plotH
              return (
                <g key={g}>
                  <line x1={PAD_L} x2={PAD_L + plotW} y1={gy} y2={gy} className="chart-grid" />
                  <text x={PAD_L - 6} y={gy + 3} className="chart-tick" textAnchor="end">
                    {formatValue(g * maxValue)}
                  </text>
                </g>
              )
            })}
            <text x={PAD_L} y={height - 5} className="chart-tick">
              {timeLabel(times[0]!)}
            </text>
            <text x={PAD_L + plotW} y={height - 5} className="chart-tick" textAnchor="end">
              {timeLabel(times[times.length - 1]!)}
            </text>

            {series.map((s, si) => (
              <path key={s.name} d={paths[si]} className="chart-line" style={{ stroke: s.color }} />
            ))}

            {/* Last-value direct labels (contrast relief), collision-resolved */}
            {(() => {
              const labels = series
                .map((s) => {
                  const v = lastValue(s)
                  return v === null ? null : { name: s.name, color: s.color, markY: y(v), labelY: y(v), value: v }
                })
                .filter((l): l is NonNullable<typeof l> => l !== null)
                .sort((a, b) => a.labelY - b.labelY)
              for (let i = 1; i < labels.length; i++) {
                if (labels[i]!.labelY - labels[i - 1]!.labelY < 11) {
                  labels[i]!.labelY = labels[i - 1]!.labelY + 11
                }
              }
              const overflow = labels.length > 0 ? labels[labels.length - 1]!.labelY - (height - 4) : 0
              if (overflow > 0) for (const l of labels) l.labelY -= overflow
              return labels.map((l) => (
                <g key={`label-${l.name}`}>
                  <circle cx={PAD_L + plotW} cy={l.markY} r={3} style={{ fill: l.color }} />
                  <text x={PAD_L + plotW + 6} y={l.labelY + 3} className="chart-value-label">
                    {formatValue(l.value)}
                  </text>
                </g>
              ))
            })()}

            {hover !== null && (
              <g>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PAD_T}
                  y2={PAD_T + plotH}
                  className="chart-crosshair"
                />
                {series.map((s) => {
                  const v = s.values[hover]
                  if (v === null || v === undefined) return null
                  return (
                    <circle
                      key={s.name}
                      cx={x(hover)}
                      cy={y(v)}
                      r={4}
                      style={{ fill: s.color }}
                      className="chart-marker"
                    />
                  )
                })}
              </g>
            )}
          </svg>
        )}

        {hover !== null && (
          <div
            className="chart-tooltip"
            style={{
              left: flipTooltip ? undefined : tooltipLeft + 10,
              right: flipTooltip ? width - tooltipLeft + 10 : undefined,
              top: PAD_T,
            }}
          >
            <div className="chart-tooltip-time">{timeLabel(times[hover]!)}</div>
            {series.map((s) => (
              <div key={s.name} className="chart-tooltip-row">
                <span className="chart-swatch" style={{ background: s.color }} />
                <span className="grow">{s.name}</span>
                <span className="mono">
                  {s.values[hover] === null || s.values[hover] === undefined
                    ? '—'
                    : formatValue(s.values[hover] as number)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => {
            const v = lastValue(s)
            return (
              <span key={s.name} className="chart-legend-item">
                <span className="chart-swatch" style={{ background: s.color }} />
                {s.name}
                <span className="mono chart-legend-value">{v === null ? '—' : formatValue(v)}</span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

export interface BarItem {
  label: string
  value: number
  color?: string
  /** Pre-formatted display value. */
  display: string
}

export function HBars({
  title,
  items,
  emptyLabel,
}: {
  title: string
  items: BarItem[]
  emptyLabel: string
}) {
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      {items.length === 0 ? (
        <div className="chart-empty" style={{ height: 80 }}>
          {emptyLabel}
        </div>
      ) : (
        <div className="hbar-list">
          {items.map((item) => (
            <div key={item.label} className="hbar-row" title={`${item.label}: ${item.display}`}>
              <span className="hbar-label mono truncate">{item.label}</span>
              <span className="hbar-track">
                <span
                  className="hbar-fill"
                  style={{
                    width: `${Math.max((item.value / max) * 100, 1)}%`,
                    background: item.color ?? 'var(--chart-1)',
                  }}
                />
              </span>
              <span className="hbar-value mono">{item.display}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
