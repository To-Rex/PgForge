/**
 * Client-side read/write classification for SQL. Purely advisory: the server
 * re-checks every statement. It exists so the UI can warn before `EXPLAIN
 * ANALYZE` — which really executes the statement — is pointed at a write.
 */

const READ_ONLY_KEYWORDS = new Set(['select', 'with', 'table', 'values', 'show', 'explain'])
const WRITE_IN_CTE = /\b(insert|update|delete|merge)\s+/i

/** Strips leading comments and whitespace, then returns the first word, lowercased. */
export function firstKeyword(sql: string): string {
  let rest = sql
  // Loop: comments and blank space can alternate any number of times.
  for (;;) {
    const before = rest
    rest = rest.replace(/^\s+/, '')
    if (rest.startsWith('--')) {
      const end = rest.indexOf('\n')
      rest = end === -1 ? '' : rest.slice(end + 1)
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/')
      rest = end === -1 ? '' : rest.slice(end + 2)
    }
    if (rest === before) break
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
  return match ? match[0].toLowerCase() : ''
}

/**
 * True when the statement only reads. A data-modifying CTE
 * (`WITH x AS (DELETE …) SELECT …`) writes despite starting with `WITH`, so
 * `with` is accepted only when no write keyword appears anywhere in it.
 */
export function looksReadOnly(sql: string): boolean {
  const keyword = firstKeyword(sql)
  if (keyword.length === 0) return true
  if (!READ_ONLY_KEYWORDS.has(keyword)) return false
  if (keyword === 'with') return !WRITE_IN_CTE.test(sql)
  return true
}
