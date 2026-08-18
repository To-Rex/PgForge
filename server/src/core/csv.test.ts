import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv.js'

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('handles quoted fields with delimiters and newlines', () => {
    expect(parseCsv('name,note\n"Doe, J","line1\nline2"\n', ',')).toEqual([
      ['name', 'note'],
      ['Doe, J', 'line1\nline2'],
    ])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCsv('q\n"say ""hi"""\n', ',')).toEqual([['q'], ['say "hi"']])
  })

  it('supports CRLF and semicolon delimiter', () => {
    expect(parseCsv('a;b\r\n1;2\r\n', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('keeps empty fields', () => {
    expect(parseCsv('a,b,c\n1,,3\n', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ])
  })

  it('rejects unterminated quotes', () => {
    expect(() => parseCsv('a\n"broken\n', ',')).toThrow()
  })

  it('ignores trailing blank lines', () => {
    expect(parseCsv('a\n1\n\n\n', ',')).toEqual([['a'], ['1']])
  })
})
