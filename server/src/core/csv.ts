import { BadRequestError } from './errors.js'

/**
 * RFC-4180-style CSV parser: quoted fields, doubled-quote escapes, embedded
 * delimiters/newlines inside quotes, and both \n and \r\n row endings.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  if (delimiter.length !== 1) throw new BadRequestError('Delimiter must be a single character')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // Skip fully empty trailing lines.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (i < len) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      endField()
      i++
      continue
    }
    if (ch === '\n') {
      endRow()
      i++
      continue
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      endRow()
      i++
      continue
    }
    field += ch
    i++
  }
  if (inQuotes) throw new BadRequestError('Malformed CSV: unterminated quoted field')
  if (field !== '' || row.length > 0) endRow()
  return rows
}
