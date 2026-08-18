import { BadRequestError } from './errors.js'

/**
 * Quote a PostgreSQL identifier. Identifiers can never be parameterized, so
 * every dynamic identifier in the codebase MUST pass through here.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0 || name.length > 128 || name.includes('\0')) {
    throw new BadRequestError(`Invalid identifier: ${JSON.stringify(name)}`)
  }
  return `"${name.replaceAll('"', '""')}"`
}

export function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}

/** Quote a string literal (assumes standard_conforming_strings=on, PG default). */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new BadRequestError('Literal contains NUL byte')
  return `'${value.replaceAll("'", "''")}'`
}
