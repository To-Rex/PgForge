import { describe, expect, it } from 'vitest'
import { firstKeyword, isReadOnlyStatement, splitSqlStatements } from './sql-split.js'

describe('splitSqlStatements', () => {
  it('splits simple statements', () => {
    const parts = splitSqlStatements('SELECT 1; SELECT 2;')
    expect(parts.map((p) => p.text)).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('ignores semicolons inside single-quoted strings', () => {
    const parts = splitSqlStatements("SELECT 'a;b'; SELECT 2")
    expect(parts).toHaveLength(2)
    expect(parts[0]!.text).toBe("SELECT 'a;b'")
  })

  it('handles escaped quotes and E-strings', () => {
    expect(splitSqlStatements("SELECT 'it''s; fine'")).toHaveLength(1)
    expect(splitSqlStatements("SELECT E'a\\';b'; SELECT 1")).toHaveLength(2)
  })

  it('ignores semicolons in comments', () => {
    const script = `-- comment; with semicolon
      SELECT 1; /* block; comment */ SELECT 2`
    expect(splitSqlStatements(script)).toHaveLength(2)
  })

  it('handles nested block comments', () => {
    expect(splitSqlStatements('/* outer /* inner; */ still; */ SELECT 1')).toHaveLength(1)
  })

  it('keeps dollar-quoted function bodies intact', () => {
    const fn = `CREATE FUNCTION f() RETURNS void AS $$
      BEGIN PERFORM 1; PERFORM 2; END;
    $$ LANGUAGE plpgsql; SELECT 1`
    const parts = splitSqlStatements(fn)
    expect(parts).toHaveLength(2)
    expect(parts[0]!.text).toContain('PERFORM 2;')
  })

  it('supports tagged dollar quotes', () => {
    expect(splitSqlStatements('SELECT $tag$ a; b $tag$; SELECT 2')).toHaveLength(2)
  })

  it('reports statement offsets', () => {
    const parts = splitSqlStatements('SELECT 1;  SELECT 2')
    expect(parts[1]!.offset).toBeGreaterThan(parts[0]!.offset)
  })

  it('drops empty trailing statements', () => {
    expect(splitSqlStatements('SELECT 1; \n ;; ')).toHaveLength(1)
  })
})

describe('firstKeyword', () => {
  it('skips leading comments', () => {
    expect(firstKeyword('-- hey\n /* x */ SELECT 1')).toBe('select')
  })

  it('lowercases keywords', () => {
    expect(firstKeyword('  UPDATE t SET x = 1')).toBe('update')
  })
})

describe('isReadOnlyStatement', () => {
  it.each(['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', 'EXPLAIN SELECT 1', 'SHOW all', 'TABLE t', 'VALUES (1)'])(
    'allows %s',
    (sql) => expect(isReadOnlyStatement(sql)).toBe(true),
  )

  it.each(['DELETE FROM t', 'UPDATE t SET a=1', 'INSERT INTO t VALUES (1)', 'DROP TABLE t', 'SET role admin', 'BEGIN', 'DO $$ BEGIN END $$'])(
    'blocks %s',
    (sql) => expect(isReadOnlyStatement(sql)).toBe(false),
  )
})
