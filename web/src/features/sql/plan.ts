/**
 * Parses `EXPLAIN (FORMAT JSON)` output into a tree the UI can render.
 *
 * Two details of the PostgreSQL format drive everything here:
 *  - `Actual Total Time` is the average of one loop, so real time spent in a
 *    node is `Actual Total Time × Actual Loops`.
 *  - A node's time *includes* its children, so the interesting number — where
 *    the query actually spent its time — is the exclusive (self) time.
 */

export interface PlanNode {
  id: string
  nodeType: string
  /** "Seq Scan on public.orders", "Index Scan using orders_pkey". */
  label: string
  detail: string[]
  planRows: number
  actualRows: number | null
  loops: number
  totalCost: number
  /** Inclusive of children; null when the plan was not ANALYZEd. */
  totalMs: number | null
  /** Exclusive of children; the column worth sorting by. */
  selfMs: number | null
  /** actual ÷ estimated rows; null when not ANALYZEd or the estimate was 0. */
  rowsRatio: number | null
  warnings: PlanWarning[]
  children: PlanNode[]
}

export type PlanWarning = 'row_misestimate' | 'heavy_filter' | 'seq_scan' | 'external_sort'

export interface ParsedPlan {
  root: PlanNode
  analyzed: boolean
  planningMs: number | null
  executionMs: number | null
  /** Largest self time in the tree — the denominator for the time bars. */
  maxSelfMs: number
  totalCost: number
  nodeCount: number
}

type RawNode = Record<string, unknown>

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Ten-fold either way is where the planner's choice usually starts to hurt. */
const MISESTIMATE_FACTOR = 10
/** Discarding this share of what was read means the filter belongs in an index. */
const HEAVY_FILTER_RATIO = 0.9
const SEQ_SCAN_MIN_ROWS = 10_000

function buildLabel(node: RawNode): string {
  const type = str(node['Node Type']) ?? 'Node'
  const relation = str(node['Relation Name'])
  const schema = str(node['Schema'])
  const alias = str(node['Alias'])
  const index = str(node['Index Name'])
  const cte = str(node['CTE Name'])
  const qualified = relation ? (schema ? `${schema}.${relation}` : relation) : null

  if (index && qualified) return `${type} using ${index} on ${qualified}`
  if (index) return `${type} using ${index}`
  if (qualified) {
    const aliased = alias && alias !== relation ? `${qualified} (${alias})` : qualified
    return `${type} on ${aliased}`
  }
  if (cte) return `${type} on ${cte}`
  const join = str(node['Join Type'])
  return join && join !== 'Inner' ? `${join} ${type}` : type
}

const DETAIL_KEYS = [
  'Index Cond',
  'Filter',
  'Hash Cond',
  'Merge Cond',
  'Join Filter',
  'Recheck Cond',
  'Sort Key',
  'Group Key',
  'Sort Method',
  'Heap Fetches',
  'Rows Removed by Filter',
  'Rows Removed by Index Recheck',
] as const

function buildDetail(node: RawNode): string[] {
  const out: string[] = []
  for (const key of DETAIL_KEYS) {
    const value = node[key]
    if (value === undefined || value === null) continue
    const text = Array.isArray(value) ? value.join(', ') : String(value)
    if (text.length > 0) out.push(`${key}: ${text}`)
  }
  return out
}

function warningsFor(node: RawNode, planRows: number, actualRows: number | null): PlanWarning[] {
  const out: PlanWarning[] = []
  if (actualRows !== null && planRows > 0) {
    const ratio = actualRows / planRows
    if (ratio >= MISESTIMATE_FACTOR || ratio <= 1 / MISESTIMATE_FACTOR) out.push('row_misestimate')
  }
  const removed = node['Rows Removed by Filter']
  if (removed !== undefined && actualRows !== null) {
    const discarded = num(removed)
    const read = discarded + actualRows
    if (read > 0 && discarded / read >= HEAVY_FILTER_RATIO && discarded > 1_000) {
      out.push('heavy_filter')
    }
  }
  const type = str(node['Node Type'])
  if (type === 'Seq Scan' && (actualRows ?? planRows) > SEQ_SCAN_MIN_ROWS) out.push('seq_scan')
  const sortMethod = str(node['Sort Method'])
  if (sortMethod && sortMethod.includes('external')) out.push('external_sort')
  return out
}

function walk(node: RawNode, path: string): PlanNode {
  const loops = Math.max(num(node['Actual Loops']) || 1, 1)
  const hasTiming = node['Actual Total Time'] !== undefined
  // Per-loop average × loops = wall time actually spent in this node.
  const totalMs = hasTiming ? num(node['Actual Total Time']) * loops : null
  const planRows = num(node['Plan Rows'])
  const actualRows =
    node['Actual Rows'] === undefined ? null : num(node['Actual Rows']) * loops

  const rawChildren = Array.isArray(node['Plans']) ? (node['Plans'] as RawNode[]) : []
  const children = rawChildren.map((child, i) => walk(child, `${path}.${i}`))

  const childMs = children.reduce((sum, c) => sum + (c.totalMs ?? 0), 0)
  const selfMs = totalMs === null ? null : Math.max(totalMs - childMs, 0)

  return {
    id: path,
    nodeType: str(node['Node Type']) ?? 'Node',
    label: buildLabel(node),
    detail: buildDetail(node),
    planRows,
    actualRows,
    loops,
    totalCost: num(node['Total Cost']),
    totalMs,
    selfMs,
    rowsRatio: actualRows !== null && planRows > 0 ? actualRows / planRows : null,
    warnings: warningsFor(node, planRows, actualRows),
    children,
  }
}

/**
 * Accepts what the server returns for `plan`: the `EXPLAIN (FORMAT JSON)`
 * array, a single wrapper object, or a bare plan node. Returns null when the
 * shape is not recognisable rather than throwing — the raw JSON is always
 * available as a fallback view.
 */
export function parsePlan(raw: unknown): ParsedPlan | null {
  const wrapper = (Array.isArray(raw) ? raw[0] : raw) as RawNode | undefined
  if (!wrapper || typeof wrapper !== 'object') return null

  const rootRaw = (
    'Plan' in wrapper ? (wrapper['Plan'] as RawNode) : wrapper
  ) as RawNode | undefined
  if (!rootRaw || typeof rootRaw !== 'object' || rootRaw['Node Type'] === undefined) return null

  const root = walk(rootRaw, '0')

  let maxSelfMs = 0
  let nodeCount = 0
  const visit = (node: PlanNode) => {
    nodeCount += 1
    if (node.selfMs !== null && node.selfMs > maxSelfMs) maxSelfMs = node.selfMs
    node.children.forEach(visit)
  }
  visit(root)

  return {
    root,
    analyzed: root.totalMs !== null,
    planningMs: wrapper['Planning Time'] === undefined ? null : num(wrapper['Planning Time']),
    executionMs: wrapper['Execution Time'] === undefined ? null : num(wrapper['Execution Time']),
    maxSelfMs,
    totalCost: root.totalCost,
    nodeCount,
  }
}

/** Flattens the tree depth-first, carrying depth for indented rendering. */
export function flattenPlan(root: PlanNode): { node: PlanNode; depth: number }[] {
  const out: { node: PlanNode; depth: number }[] = []
  const push = (node: PlanNode, depth: number) => {
    out.push({ node, depth })
    node.children.forEach((child) => push(child, depth + 1))
  }
  push(root, 0)
  return out
}

/** The nodes worth looking at first: highest exclusive time, descending. */
export function hottestNodes(root: PlanNode, limit = 3): PlanNode[] {
  return flattenPlan(root)
    .map((entry) => entry.node)
    .filter((node) => node.selfMs !== null && node.selfMs > 0)
    .sort((a, b) => (b.selfMs ?? 0) - (a.selfMs ?? 0))
    .slice(0, limit)
}
