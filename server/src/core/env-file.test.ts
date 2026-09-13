import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  envLine,
  formatEnvValue,
  maskDatabaseUrl,
  readEnvVar,
  removeEnvVar,
  resolveEnvFile,
  resolveEnvFiles,
  upsertEnvVar,
} from './env-file.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pgforge-env-'))
  file = path.join(dir, '.env')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('formatEnvValue', () => {
  it('leaves a plain DSN unquoted', () => {
    const dsn = 'postgresql://user:pass@host:5432/db?sslmode=require'
    expect(formatEnvValue(dsn)).toBe(dsn)
  })

  it('quotes values containing spaces or quotes', () => {
    expect(formatEnvValue('a b')).toBe('"a b"')
    expect(formatEnvValue('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('renders an empty value as empty', () => {
    expect(formatEnvValue('')).toBe('')
  })
})

describe('readEnvVar', () => {
  it('returns null for a missing file', () => {
    expect(readEnvVar(path.join(dir, 'nope'), 'METADATA_URL')).toBeNull()
  })

  it('reads a plain assignment', () => {
    writeFileSync(file, 'PORT=7070\nMETADATA_URL=postgres://a/b\n')
    expect(readEnvVar(file, 'METADATA_URL')).toBe('postgres://a/b')
  })

  it('ignores commented-out assignments', () => {
    writeFileSync(file, '# METADATA_URL=postgres://commented/out\nPORT=1\n')
    expect(readEnvVar(file, 'METADATA_URL')).toBeNull()
  })

  it('strips surrounding quotes', () => {
    writeFileSync(file, 'METADATA_URL="postgres://a b/c"\n')
    expect(readEnvVar(file, 'METADATA_URL')).toBe('postgres://a b/c')
  })

  it('handles an export prefix', () => {
    writeFileSync(file, 'export METADATA_URL=postgres://x/y\n')
    expect(readEnvVar(file, 'METADATA_URL')).toBe('postgres://x/y')
  })

  it('does not match a key that merely shares a prefix', () => {
    writeFileSync(file, 'METADATA_URL_OLD=postgres://old/db\n')
    expect(readEnvVar(file, 'METADATA_URL')).toBeNull()
  })
})

describe('upsertEnvVar', () => {
  it('creates the file when absent', () => {
    upsertEnvVar(file, 'METADATA_URL', 'postgres://a/b')
    expect(readEnvVar(file, 'METADATA_URL')).toBe('postgres://a/b')
  })

  it('replaces an existing value in place, preserving order', () => {
    writeFileSync(file, 'PORT=7070\nMETADATA_URL=postgres://old/db\nHOST=0.0.0.0\n')
    upsertEnvVar(file, 'METADATA_URL', 'postgres://new/db')
    expect(readFileSync(file, 'utf8')).toBe(
      'PORT=7070\nMETADATA_URL=postgres://new/db\nHOST=0.0.0.0\n',
    )
  })

  it('preserves comments and unrelated keys when appending', () => {
    writeFileSync(file, '# a note\nPORT=7070\n')
    upsertEnvVar(file, 'METADATA_URL', 'postgres://a/b')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# a note')
    expect(text).toContain('PORT=7070')
    expect(text.trimEnd().endsWith('METADATA_URL=postgres://a/b')).toBe(true)
  })

  it('appends rather than editing a commented placeholder', () => {
    writeFileSync(file, '# METADATA_URL=postgres://example\n')
    upsertEnvVar(file, 'METADATA_URL', 'postgres://real/db')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# METADATA_URL=postgres://example')
    expect(readEnvVar(file, 'METADATA_URL')).toBe('postgres://real/db')
  })

  it('round-trips a value needing quotes', () => {
    upsertEnvVar(file, 'METADATA_URL', 'postgres://u:p a s s@h/db')
    expect(readEnvVar(file, 'METADATA_URL')).toBe('postgres://u:p a s s@h/db')
  })
})

describe('removeEnvVar', () => {
  it('removes the assignment and leaves the rest', () => {
    writeFileSync(file, 'PORT=7070\nMETADATA_URL=postgres://a/b\nHOST=0.0.0.0\n')
    removeEnvVar(file, 'METADATA_URL')
    expect(readFileSync(file, 'utf8')).toBe('PORT=7070\nHOST=0.0.0.0\n')
    expect(readEnvVar(file, 'METADATA_URL')).toBeNull()
  })

  it('keeps commented placeholders', () => {
    writeFileSync(file, '# METADATA_URL=doc\nMETADATA_URL=postgres://a/b\n')
    removeEnvVar(file, 'METADATA_URL')
    expect(readFileSync(file, 'utf8')).toBe('# METADATA_URL=doc\n')
  })

  it('is a no-op for a missing file', () => {
    expect(() => removeEnvVar(path.join(dir, 'nope'), 'METADATA_URL')).not.toThrow()
  })
})

describe('envLine', () => {
  it('renders the exact line an operator can paste', () => {
    expect(envLine('METADATA_URL', 'postgres://a/b')).toBe('METADATA_URL=postgres://a/b')
  })
})

describe('maskDatabaseUrl', () => {
  it('hides the password', () => {
    expect(maskDatabaseUrl('postgresql://user:s3cret@host:5432/db')).toBe(
      'postgresql://user:***@host:5432/db',
    )
  })

  it('leaves a password-free DSN recognisable', () => {
    expect(maskDatabaseUrl('postgresql://host:5432/db')).toContain('host:5432/db')
  })

  it('never echoes an unparseable string back', () => {
    expect(maskDatabaseUrl('not a url')).toBe('(unparseable connection string)')
  })

  it('keeps query parameters', () => {
    expect(maskDatabaseUrl('postgresql://u:p@h/db?sslmode=require')).toContain('sslmode=require')
  })
})


/**
 * Startup stops at the first `.env` it finds, but a save has to reach all of
 * them: otherwise a value left in the other file resurfaces the moment the
 * first one is added or removed.
 */
describe('resolveEnvFiles', () => {
  /** Mirrors the real layout: the server runs from a subdirectory of the repo. */
  const layout = (files: ('cwd' | 'parent')[]) => {
    const cwd = path.join(dir, 'app')
    mkdirSync(cwd, { recursive: true })
    if (files.includes('cwd')) writeFileSync(path.join(cwd, '.env'), 'PORT=7070\n')
    if (files.includes('parent')) writeFileSync(path.join(dir, '.env'), 'PORT=8080\n')
    return cwd
  }

  it('returns the default location when none exist', () => {
    const cwd = layout([])
    expect(resolveEnvFiles(cwd)).toEqual([path.join(cwd, '.env')])
  })

  it('returns only the files that exist', () => {
    const cwd = layout(['parent'])
    expect(resolveEnvFiles(cwd)).toEqual([path.join(dir, '.env')])
  })

  it('returns both, nearest first', () => {
    const cwd = layout(['cwd', 'parent'])
    expect(resolveEnvFiles(cwd)).toEqual([path.join(cwd, '.env'), path.join(dir, '.env')])
  })

  it('resolveEnvFile names the one startup will read', () => {
    const cwd = layout(['cwd', 'parent'])
    expect(resolveEnvFile(cwd)).toBe(path.join(cwd, '.env'))
  })

  it('writing to every returned file leaves them agreeing', () => {
    const cwd = layout(['cwd', 'parent'])
    const files = resolveEnvFiles(cwd)
    for (const target of files) upsertEnvVar(target, 'METADATA_URL', 'postgres://a/b')
    expect(files.map((f) => readEnvVar(f, 'METADATA_URL'))).toEqual([
      'postgres://a/b',
      'postgres://a/b',
    ])
    // Unrelated keys in each file are untouched.
    expect(readEnvVar(files[0]!, 'PORT')).toBe('7070')
    expect(readEnvVar(files[1]!, 'PORT')).toBe('8080')
  })

  it('removing from every returned file leaves none behind', () => {
    const cwd = layout(['cwd', 'parent'])
    const files = resolveEnvFiles(cwd)
    for (const target of files) upsertEnvVar(target, 'METADATA_URL', 'postgres://a/b')
    for (const target of files) removeEnvVar(target, 'METADATA_URL')
    expect(files.map((f) => readEnvVar(f, 'METADATA_URL'))).toEqual([null, null])
  })
})
