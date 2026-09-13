import { describe, expect, it } from 'vitest'
import { firstKeyword, looksReadOnly } from './sql-kind.js'

describe('firstKeyword', () => {
  it('reads the leading keyword', () => {
    expect(firstKeyword('SELECT 1')).toBe('select')
  })

  it('skips leading whitespace and newlines', () => {
    expect(firstKeyword('\n\n   UPDATE t SET a = 1')).toBe('update')
  })

  it('skips a line comment', () => {
    expect(firstKeyword('-- a note\nDELETE FROM t')).toBe('delete')
  })

  it('skips a block comment', () => {
    expect(firstKeyword('/* header */ INSERT INTO t VALUES (1)')).toBe('insert')
  })

  it('skips alternating comments and whitespace', () => {
    expect(firstKeyword('  -- one\n  /* two */\n\n  SELECT 1')).toBe('select')
  })

  it('returns empty for whitespace only', () => {
    expect(firstKeyword('   \n  ')).toBe('')
  })

  it('returns empty for an unterminated block comment', () => {
    expect(firstKeyword('/* never closed SELECT 1')).toBe('')
  })
})

describe('looksReadOnly', () => {
  it('accepts SELECT', () => {
    expect(looksReadOnly('SELECT * FROM users')).toBe(true)
  })

  it('accepts a read-only CTE', () => {
    expect(looksReadOnly('WITH recent AS (SELECT * FROM t) SELECT * FROM recent')).toBe(true)
  })

  it('rejects a data-modifying CTE', () => {
    expect(
      looksReadOnly('WITH gone AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM gone'),
    ).toBe(false)
  })

  it('rejects an updating CTE', () => {
    expect(looksReadOnly('WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u')).toBe(false)
  })

  it('rejects UPDATE, DELETE, INSERT and DDL', () => {
    expect(looksReadOnly('UPDATE t SET a = 1')).toBe(false)
    expect(looksReadOnly('DELETE FROM t')).toBe(false)
    expect(looksReadOnly('INSERT INTO t VALUES (1)')).toBe(false)
    expect(looksReadOnly('DROP TABLE t')).toBe(false)
    expect(looksReadOnly('TRUNCATE t')).toBe(false)
  })

  it('accepts VALUES, SHOW and TABLE', () => {
    expect(looksReadOnly('VALUES (1), (2)')).toBe(true)
    expect(looksReadOnly('SHOW work_mem')).toBe(true)
    expect(looksReadOnly('TABLE users')).toBe(true)
  })

  it('treats empty input as harmless', () => {
    expect(looksReadOnly('')).toBe(true)
    expect(looksReadOnly('   ')).toBe(true)
  })

  it('ignores case and leading comments', () => {
    expect(looksReadOnly('-- report\nsElEcT 1')).toBe(true)
  })
})
