import { describe, expect, it } from 'vitest'
import { BadRequestError } from '../../core/errors.js'
import { buildOrderBy, buildWhere, type ColumnMeta } from './filter-builder.js'

const columns: ColumnMeta[] = [
  { name: 'id', dataType: 'integer' },
  { name: 'name', dataType: 'text' },
  { name: 'created_at', dataType: 'timestamptz' },
  { name: 'weird"col', dataType: 'text' },
]

describe('buildWhere', () => {
  it('returns empty clause with no filters', () => {
    expect(buildWhere([], undefined, columns)).toEqual({ clause: '', params: [] })
  })

  it('builds parameterized comparisons', () => {
    const built = buildWhere([{ column: 'id', op: 'gte', value: '5' }], undefined, columns)
    expect(built.clause).toBe('WHERE "id" >= $1')
    expect(built.params).toEqual(['5'])
  })

  it('rejects unknown columns instead of interpolating them', () => {
    expect(() =>
      buildWhere([{ column: 'id; DROP TABLE x', op: 'eq', value: '1' }], undefined, columns),
    ).toThrow(BadRequestError)
  })

  it('quotes identifiers with embedded quotes', () => {
    const built = buildWhere([{ column: 'weird"col', op: 'eq', value: 'x' }], undefined, columns)
    expect(built.clause).toBe('WHERE "weird""col" = $1')
  })

  it('escapes LIKE wildcards in contains', () => {
    const built = buildWhere([{ column: 'name', op: 'contains', value: '50%_x' }], undefined, columns)
    expect(built.params[0]).toBe('%50\\%\\_x%')
  })

  it('splits IN lists', () => {
    const built = buildWhere([{ column: 'id', op: 'in', value: '1, 2, 3' }], undefined, columns)
    expect(built.clause).toContain('= ANY($1)')
    expect(built.params[0]).toEqual(['1', '2', '3'])
  })

  it('handles null checks without params', () => {
    const built = buildWhere([{ column: 'name', op: 'is_null' }], undefined, columns)
    expect(built).toEqual({ clause: 'WHERE "name" IS NULL', params: [] })
  })

  it('applies search only to textual columns', () => {
    const built = buildWhere([], 'foo', columns)
    expect(built.clause).toContain('"name"::text ILIKE $1')
    expect(built.clause).not.toContain('"id"')
    expect(built.clause).not.toContain('"created_at"')
  })
})

describe('buildOrderBy', () => {
  it('builds a validated order clause', () => {
    expect(buildOrderBy([{ column: 'name', dir: 'desc' }], columns)).toBe(
      'ORDER BY "name" DESC NULLS LAST',
    )
  })

  it('rejects unknown sort columns', () => {
    expect(() => buildOrderBy([{ column: 'nope', dir: 'asc' }], columns)).toThrow(BadRequestError)
  })
})
