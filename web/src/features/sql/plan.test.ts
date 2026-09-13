import { describe, expect, it } from 'vitest'
import { flattenPlan, hottestNodes, parsePlan } from './plan.js'

/** Shape of a real `EXPLAIN (ANALYZE, FORMAT JSON)` response. */
const ANALYZED = [
  {
    Plan: {
      'Node Type': 'Nested Loop',
      'Total Cost': 120.5,
      'Plan Rows': 100,
      'Actual Rows': 90,
      'Actual Loops': 1,
      'Actual Total Time': 50,
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          Schema: 'public',
          Alias: 'o',
          'Total Cost': 80,
          'Plan Rows': 1_000,
          'Actual Rows': 20_000,
          'Actual Loops': 1,
          'Actual Total Time': 30,
          Filter: '(status = 1)',
          'Rows Removed by Filter': 500_000,
        },
        {
          'Node Type': 'Index Scan',
          'Index Name': 'customers_pkey',
          'Relation Name': 'customers',
          Schema: 'public',
          'Total Cost': 8,
          'Plan Rows': 1,
          'Actual Rows': 1,
          'Actual Loops': 10,
          'Actual Total Time': 0.5,
        },
      ],
    },
    'Planning Time': 1.25,
    'Execution Time': 52.5,
  },
]

const ESTIMATE_ONLY = [
  {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 'users',
      'Total Cost': 42,
      'Plan Rows': 10,
    },
  },
]

describe('parsePlan', () => {
  it('returns null for unrecognisable input', () => {
    expect(parsePlan(null)).toBeNull()
    expect(parsePlan({})).toBeNull()
    expect(parsePlan([{ nope: true }])).toBeNull()
    expect(parsePlan('not a plan')).toBeNull()
  })

  it('accepts a bare plan node as well as the array wrapper', () => {
    expect(parsePlan(ESTIMATE_ONLY)?.root.nodeType).toBe('Seq Scan')
    expect(parsePlan(ESTIMATE_ONLY[0])?.root.nodeType).toBe('Seq Scan')
    expect(parsePlan(ESTIMATE_ONLY[0]!.Plan)?.root.nodeType).toBe('Seq Scan')
  })

  it('reads planning and execution time', () => {
    const parsed = parsePlan(ANALYZED)!
    expect(parsed.analyzed).toBe(true)
    expect(parsed.planningMs).toBe(1.25)
    expect(parsed.executionMs).toBe(52.5)
    expect(parsed.nodeCount).toBe(3)
  })

  it('marks an un-analyzed plan and leaves timings null', () => {
    const parsed = parsePlan(ESTIMATE_ONLY)!
    expect(parsed.analyzed).toBe(false)
    expect(parsed.root.totalMs).toBeNull()
    expect(parsed.root.selfMs).toBeNull()
    expect(parsed.root.actualRows).toBeNull()
  })

  it('multiplies per-loop time and rows by the loop count', () => {
    const indexScan = parsePlan(ANALYZED)!.root.children[1]!
    expect(indexScan.loops).toBe(10)
    expect(indexScan.totalMs).toBeCloseTo(5) // 0.5 ms × 10 loops
    expect(indexScan.actualRows).toBe(10) // 1 row × 10 loops
  })

  it('computes self time by subtracting children', () => {
    const parsed = parsePlan(ANALYZED)!
    // root 50 − (seq scan 30 + index scan 0.5×10) = 15
    expect(parsed.root.selfMs).toBeCloseTo(15)
    expect(parsed.root.children[0]!.selfMs).toBeCloseTo(30)
  })

  it('never reports negative self time', () => {
    const skewed = [
      {
        Plan: {
          'Node Type': 'Limit',
          'Total Cost': 1,
          'Plan Rows': 1,
          'Actual Rows': 1,
          'Actual Loops': 1,
          'Actual Total Time': 1,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Total Cost': 1,
              'Plan Rows': 1,
              'Actual Rows': 1,
              'Actual Loops': 1,
              'Actual Total Time': 5,
            },
          ],
        },
      },
    ]
    expect(parsePlan(skewed)!.root.selfMs).toBe(0)
  })

  it('builds readable labels', () => {
    const parsed = parsePlan(ANALYZED)!
    expect(parsed.root.children[0]!.label).toBe('Seq Scan on public.orders (o)')
    expect(parsed.root.children[1]!.label).toBe('Index Scan using customers_pkey on public.customers')
  })

  it('flags a row misestimate', () => {
    const seqScan = parsePlan(ANALYZED)!.root.children[0]!
    expect(seqScan.rowsRatio).toBe(20) // 20 000 actual ÷ 1 000 planned
    expect(seqScan.warnings).toContain('row_misestimate')
  })

  it('flags a filter that discards nearly everything', () => {
    expect(parsePlan(ANALYZED)!.root.children[0]!.warnings).toContain('heavy_filter')
  })

  it('flags a large sequential scan', () => {
    expect(parsePlan(ANALYZED)!.root.children[0]!.warnings).toContain('seq_scan')
  })

  it('does not flag a small sequential scan', () => {
    expect(parsePlan(ESTIMATE_ONLY)!.root.warnings).not.toContain('seq_scan')
  })

  it('flags a sort that spilled to disk', () => {
    const sorted = [
      {
        Plan: {
          'Node Type': 'Sort',
          'Total Cost': 5,
          'Plan Rows': 10,
          'Actual Rows': 10,
          'Actual Loops': 1,
          'Actual Total Time': 2,
          'Sort Method': 'external merge  Disk: 4000kB',
        },
      },
    ]
    expect(parsePlan(sorted)!.root.warnings).toContain('external_sort')
  })

  it('collects detail lines for conditions and filters', () => {
    const seqScan = parsePlan(ANALYZED)!.root.children[0]!
    expect(seqScan.detail).toContain('Filter: (status = 1)')
    expect(seqScan.detail).toContain('Rows Removed by Filter: 500000')
  })

  it('tracks the largest self time for bar scaling', () => {
    expect(parsePlan(ANALYZED)!.maxSelfMs).toBeCloseTo(30)
  })
})

describe('flattenPlan', () => {
  it('walks depth-first with depth', () => {
    const rows = flattenPlan(parsePlan(ANALYZED)!.root)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1])
    expect(rows[0]!.node.nodeType).toBe('Nested Loop')
  })
})

describe('hottestNodes', () => {
  it('ranks by exclusive time, descending', () => {
    const hot = hottestNodes(parsePlan(ANALYZED)!.root)
    expect(hot[0]!.nodeType).toBe('Seq Scan')
    expect(hot[1]!.nodeType).toBe('Nested Loop')
  })

  it('is empty for a plan without timings', () => {
    expect(hottestNodes(parsePlan(ESTIMATE_ONLY)!.root)).toEqual([])
  })

  it('respects the limit', () => {
    expect(hottestNodes(parsePlan(ANALYZED)!.root, 1)).toHaveLength(1)
  })
})
