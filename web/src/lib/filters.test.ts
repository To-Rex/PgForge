import { describe, expect, it } from 'vitest'
import type { RowFilter } from '@pgforge/shared'
import { decodeFilter, decodeFilters, encodeFilter, encodeFilters, filterSignature } from './filters.js'

describe('encodeFilter / decodeFilter', () => {
  it('round-trips a simple filter', () => {
    const filter: RowFilter = { column: 'customer_id', op: 'eq', value: '42' }
    expect(decodeFilter(encodeFilter(filter))).toEqual(filter)
  })

  it('preserves values containing the separator', () => {
    const filter: RowFilter = { column: 'created_at', op: 'gte', value: '2024-01-01T10:30:00' }
    const decoded = decodeFilter(encodeFilter(filter))
    expect(decoded?.value).toBe('2024-01-01T10:30:00')
  })

  it('preserves column names containing the separator', () => {
    const filter: RowFilter = { column: 'weird:name', op: 'eq', value: 'x' }
    expect(decodeFilter(encodeFilter(filter))).toEqual(filter)
  })

  it('omits value for the valueless operators', () => {
    const filter: RowFilter = { column: 'deleted_at', op: 'is_null' }
    expect(decodeFilter(encodeFilter(filter))).toEqual(filter)
  })

  it('keeps an empty string distinct from no value', () => {
    const decoded = decodeFilter(encodeFilter({ column: 'note', op: 'eq', value: '' }))
    expect(decoded).toEqual({ column: 'note', op: 'eq', value: '' })
  })

  it('handles values with percent and plus signs', () => {
    const filter: RowFilter = { column: 'q', op: 'contains', value: '100% a+b' }
    expect(decodeFilter(encodeFilter(filter))).toEqual(filter)
  })
})

describe('decodeFilter rejects malformed input', () => {
  it('rejects an unknown operator', () => {
    expect(decodeFilter('col:drop:1')).toBeNull()
  })

  it('rejects a missing operator', () => {
    expect(decodeFilter('justacolumn')).toBeNull()
  })

  it('rejects an empty column', () => {
    expect(decodeFilter(':eq:1')).toBeNull()
  })

  it('rejects broken percent-encoding instead of throwing', () => {
    expect(decodeFilter('%E0%A4%A:eq:1')).toBeNull()
  })
})

describe('decodeFilters', () => {
  it('drops only the malformed entries', () => {
    const raw = [encodeFilter({ column: 'a', op: 'eq', value: '1' }), 'nope', 'b:bogus:2']
    expect(decodeFilters(raw)).toEqual([{ column: 'a', op: 'eq', value: '1' }])
  })

  it('round-trips a composite key selection', () => {
    const filters: RowFilter[] = [
      { column: 'tenant_id', op: 'eq', value: '7' },
      { column: 'order_no', op: 'eq', value: 'A-19' },
    ]
    expect(decodeFilters(encodeFilters(filters))).toEqual(filters)
  })
})

describe('filterSignature', () => {
  it('differs when a value differs', () => {
    const a = filterSignature([{ column: 'id', op: 'eq', value: '1' }])
    const b = filterSignature([{ column: 'id', op: 'eq', value: '2' }])
    expect(a).not.toBe(b)
  })

  it('is stable for the same filters', () => {
    const filters: RowFilter[] = [{ column: 'id', op: 'eq', value: '1' }]
    expect(filterSignature(filters)).toBe(filterSignature([...filters]))
  })

  it('is empty for no filters', () => {
    expect(filterSignature([])).toBe('')
  })
})
