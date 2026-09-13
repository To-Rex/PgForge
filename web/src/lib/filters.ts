import type { FilterOp, RowFilter } from '@pgforge/shared'

const OPS: FilterOp[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts',
  'ends',
  'in',
  'is_null',
  'not_null',
]

const OP_SET = new Set<string>(OPS)

/**
 * Grid filters travel in the URL so a filtered view is linkable — which is what
 * makes "jump to the parent row" a normal navigation rather than hidden state.
 *
 * Each filter is one `f` parameter shaped `column:op:value`. The column and
 * value are percent-encoded individually, so a value containing `:` survives
 * the round trip intact.
 */
export function encodeFilter(filter: RowFilter): string {
  const value = filter.value ?? ''
  return `${encodeURIComponent(filter.column)}:${filter.op}:${encodeURIComponent(value)}`
}

export function encodeFilters(filters: RowFilter[]): string[] {
  return filters.map(encodeFilter)
}

/** Returns null for anything malformed, so a hand-edited URL degrades quietly. */
export function decodeFilter(raw: string): RowFilter | null {
  const parts = raw.split(':')
  if (parts.length < 2) return null
  const [rawColumn, rawOp, ...rest] = parts
  if (!rawColumn || !rawOp || !OP_SET.has(rawOp)) return null
  let column: string
  let value: string
  try {
    column = decodeURIComponent(rawColumn)
    value = decodeURIComponent(rest.join(':'))
  } catch {
    return null
  }
  if (column.length === 0) return null
  const op = rawOp as FilterOp
  if (op === 'is_null' || op === 'not_null') return { column, op }
  return { column, op, value }
}

export function decodeFilters(raw: string[]): RowFilter[] {
  const out: RowFilter[] = []
  for (const entry of raw) {
    const filter = decodeFilter(entry)
    if (filter) out.push(filter)
  }
  return out
}

/** Stable identity for a filter set — used as a remount key when it changes. */
export function filterSignature(filters: RowFilter[]): string {
  return encodeFilters(filters).join('|')
}
