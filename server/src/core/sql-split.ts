export interface SqlStatement {
  text: string
  /** 0-based character offset of the statement within the original script. */
  offset: number
}

/**
 * Split a SQL script into top-level statements, honoring line/block comments,
 * quoted strings ('', "", E''), and dollar-quoted bodies ($tag$ ... $tag$).
 * Statement text keeps its original form (no trimming of inner whitespace).
 */
export function splitSqlStatements(script: string): SqlStatement[] {
  const statements: SqlStatement[] = []
  const len = script.length
  let start = 0
  let i = 0

  const push = (end: number) => {
    const text = script.slice(start, end)
    if (text.trim().length > 0) statements.push({ text: text.trim(), offset: start })
    start = end + 1
  }

  while (i < len) {
    const ch = script[i]
    const next = script[i + 1]

    if (ch === '-' && next === '-') {
      const nl = script.indexOf('\n', i)
      i = nl === -1 ? len : nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < len && depth > 0) {
        if (script[i] === '/' && script[i + 1] === '*') {
          depth++
          i += 2
        } else if (script[i] === '*' && script[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    if (ch === "'") {
      const escaped = script[i - 1] === 'E' || script[i - 1] === 'e'
      i++
      while (i < len) {
        if (escaped && script[i] === '\\') {
          i += 2
          continue
        }
        if (script[i] === "'") {
          if (script[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '"') {
      i++
      while (i < len) {
        if (script[i] === '"') {
          if (script[i + 1] === '"') {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const close = script.indexOf(tag, i + tag.length)
        i = close === -1 ? len : close + tag.length
        continue
      }
    }
    if (ch === ';') {
      push(i)
      i++
      continue
    }
    i++
  }
  push(len)
  return statements
}

/** First meaningful keyword of a statement, lowercased ('' when none found). */
export function firstKeyword(statement: string): string {
  let s = statement
  // Strip leading comments and whitespace.
  for (;;) {
    const trimmed = s.trimStart()
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n')
      if (nl === -1) return ''
      s = trimmed.slice(nl + 1)
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/')
      if (end === -1) return ''
      s = trimmed.slice(end + 2)
    } else {
      s = trimmed
      break
    }
  }
  const match = /^[A-Za-z_]+/.exec(s)
  return match ? match[0].toLowerCase() : ''
}

const READ_ONLY_KEYWORDS = new Set(['select', 'with', 'explain', 'show', 'table', 'values'])

/**
 * Keyword-level gate for read-only users. This is UX-level filtering only —
 * real enforcement is the surrounding `BEGIN READ ONLY` transaction, which
 * PostgreSQL applies even to data-modifying CTEs.
 */
export function isReadOnlyStatement(statement: string): boolean {
  return READ_ONLY_KEYWORDS.has(firstKeyword(statement))
}
