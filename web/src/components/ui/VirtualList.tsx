import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

interface Range {
  start: number
  end: number
}

/**
 * Windowed list for fixed-height rows that live inside someone else's scroll
 * container — the schema tree scrolls as one pane, so each relation list has to
 * read the shared scrollport rather than owning a scrollbar of its own.
 *
 * Below `threshold` rows it renders everything and gets out of the way: the
 * absolute positioning is only worth its cost once a schema holds hundreds of
 * relations.
 */
export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  scrollParentRef,
  keyOf,
  overscan = 10,
  threshold = 60,
}: {
  items: T[]
  itemHeight: number
  renderItem: (item: T, index: number) => ReactNode
  scrollParentRef: RefObject<HTMLElement | null>
  keyOf: (item: T, index: number) => string
  overscan?: number
  threshold?: number
}) {
  const outerRef = useRef<HTMLDivElement>(null)
  const rangeRef = useRef<Range>({ start: 0, end: Math.min(items.length, threshold) })
  const [range, setRange] = useState<Range>(rangeRef.current)
  const virtual = items.length > threshold

  const measure = useCallback(() => {
    const parent = scrollParentRef.current
    const outer = outerRef.current
    if (!parent || !outer) return
    // Offset of this list within the scroll container's content box. Recomputed
    // from live rects, so sibling schemas expanding above us stay accounted for.
    const offset =
      outer.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop
    const first = Math.floor((parent.scrollTop - offset) / itemHeight) - overscan
    const visible = Math.ceil(parent.clientHeight / itemHeight) + overscan * 2
    const start = Math.max(0, Math.min(first, Math.max(items.length - 1, 0)))
    const end = Math.min(items.length, start + visible)
    const current = rangeRef.current
    if (current.start === start && current.end === end) return
    rangeRef.current = { start, end }
    setRange({ start, end })
  }, [itemHeight, items.length, overscan, scrollParentRef])

  // After every render: the tree above this list may have changed height.
  useLayoutEffect(() => {
    if (virtual) measure()
  })

  useEffect(() => {
    if (!virtual) return
    const parent = scrollParentRef.current
    if (!parent) return
    parent.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      parent.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [virtual, measure, scrollParentRef])

  if (!virtual) {
    return <>{items.map((item, i) => <div key={keyOf(item, i)}>{renderItem(item, i)}</div>)}</>
  }

  const slice = items.slice(range.start, range.end)
  return (
    <div ref={outerRef} style={{ position: 'relative', height: items.length * itemHeight }}>
      {slice.map((item, i) => {
        const index = range.start + i
        return (
          <div
            key={keyOf(item, index)}
            style={{
              position: 'absolute',
              top: index * itemHeight,
              left: 0,
              right: 0,
              height: itemHeight,
            }}
          >
            {renderItem(item, index)}
          </div>
        )
      })}
    </div>
  )
}
