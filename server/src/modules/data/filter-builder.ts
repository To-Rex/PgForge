import type { RowFilter, RowSort } from '@pgforge/shared'
import { BadRequestError } from '../../core/errors.js'
import { quoteIdent } from '../../core/ident.js'

export interface ColumnMeta {
  name: string
  dataType: string
}

export interface BuiltWhere {
  clause: string
  params: unknown[]
}

const TEXTUAL = /char|text|uuid|json|name|citext|enum/i

const escapeLike = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')

/**
 * Builds a parameterized WHERE clause. Column names are validated against the
 * live table definition — unknown columns are rejected, never interpolated.
 */
export function buildWhere(
  filters: RowFilter[],
  search: string | undefined,
  columns: ColumnMeta[],
): BuiltWhere {
  const known = new Map(columns.map((c) => [c.name, c]))
  const conditions: string[] = []
  const params: unknown[] = []

  const nextParam = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }

  for (const filter of filters) {
    const column = known.get(filter.column)
    if (!column) throw new BadRequestError(`Unknown column in filter: ${filter.column}`)
    const ident = quoteIdent(column.name)
    switch (filter.op) {
      case 'eq':
        conditions.push(`${ident} = ${nextParam(filter.value)}`)
        break
      case 'neq':
        conditions.push(`${ident} <> ${nextParam(filter.value)}`)
        break
      case 'gt':
        conditions.push(`${ident} > ${nextParam(filter.value)}`)
        break
      case 'gte':
        conditions.push(`${ident} >= ${nextParam(filter.value)}`)
        break
      case 'lt':
        conditions.push(`${ident} < ${nextParam(filter.value)}`)
        break
      case 'lte':
        conditions.push(`${ident} <= ${nextParam(filter.value)}`)
        break
      case 'contains':
        conditions.push(`${ident}::text ILIKE ${nextParam(`%${escapeLike(filter.value ?? '')}%`)} ESCAPE '\\'`)
        break
      case 'starts':
        conditions.push(`${ident}::text ILIKE ${nextParam(`${escapeLike(filter.value ?? '')}%`)} ESCAPE '\\'`)
        break
      case 'ends':
        conditions.push(`${ident}::text ILIKE ${nextParam(`%${escapeLike(filter.value ?? '')}`)} ESCAPE '\\'`)
        break
      case 'in': {
        const values = (filter.value ?? '')
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
        if (values.length === 0) throw new BadRequestError(`Empty IN list for ${filter.column}`)
        conditions.push(`${ident}::text = ANY(${nextParam(values)})`)
        break
      }
      case 'is_null':
        conditions.push(`${ident} IS NULL`)
        break
      case 'not_null':
        conditions.push(`${ident} IS NOT NULL`)
        break
    }
  }

  const trimmedSearch = search?.trim()
  if (trimmedSearch) {
    const textual = columns.filter((c) => TEXTUAL.test(c.dataType))
    if (textual.length > 0) {
      const param = nextParam(`%${escapeLike(trimmedSearch)}%`)
      conditions.push(
        `(${textual.map((c) => `${quoteIdent(c.name)}::text ILIKE ${param} ESCAPE '\\'`).join(' OR ')})`,
      )
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

export function buildOrderBy(sorts: RowSort[], columns: ColumnMeta[]): string {
  if (sorts.length === 0) return ''
  const known = new Set(columns.map((c) => c.name))
  const parts = sorts.map((sort) => {
    if (!known.has(sort.column)) {
      throw new BadRequestError(`Unknown column in sort: ${sort.column}`)
    }
    return `${quoteIdent(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`
  })
  return `ORDER BY ${parts.join(', ')}`
}
