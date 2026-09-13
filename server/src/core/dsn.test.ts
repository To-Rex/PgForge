import { describe, expect, it } from 'vitest'
import type { MetadataConnectionInput } from '@pgforge/shared'
import { buildMetadataDsn, parseMetadataDsn } from './dsn.js'

const base: MetadataConnectionInput = {
  host: 'db.example.com',
  port: 5432,
  database: 'pgforge',
  username: 'pgforge',
  password: 'secret',
  sslMode: 'require',
}

const input = (over: Partial<MetadataConnectionInput> = {}): MetadataConnectionInput => ({
  ...base,
  ...over,
})

describe('buildMetadataDsn', () => {
  it('builds a plain DSN', () => {
    expect(buildMetadataDsn(input())).toBe(
      'postgresql://pgforge:secret@db.example.com:5432/pgforge?sslmode=require',
    )
  })

  it('escapes punctuation in the password', () => {
    const dsn = buildMetadataDsn(input({ password: 'p@ss:w/rd?#&=' }))
    expect(dsn).toBe(
      'postgresql://pgforge:p%40ss%3Aw%2Frd%3F%23%26%3D@db.example.com:5432/pgforge?sslmode=require',
    )
    // The escaping must survive a parse, or pg would see the wrong host.
    expect(new URL(dsn).password).toBe('p%40ss%3Aw%2Frd%3F%23%26%3D')
    expect(new URL(dsn).hostname).toBe('db.example.com')
  })

  it('escapes the username and database too', () => {
    const dsn = buildMetadataDsn(input({ username: 'user@corp', database: 'my db' }))
    expect(dsn).toContain('user%40corp')
    expect(dsn).toContain('/my%20db')
  })

  it('omits the credentials section when there is no username', () => {
    expect(buildMetadataDsn(input({ username: '', password: '' }))).toBe(
      'postgresql://db.example.com:5432/pgforge?sslmode=require',
    )
  })

  it('keeps a username with no password', () => {
    expect(buildMetadataDsn(input({ password: '' }))).toBe(
      'postgresql://pgforge@db.example.com:5432/pgforge?sslmode=require',
    )
  })

  it('brackets a bare IPv6 host', () => {
    const dsn = buildMetadataDsn(input({ host: '::1' }))
    expect(dsn).toContain('[::1]:5432')
    expect(new URL(dsn).hostname).toBe('[::1]')
  })

  it('does not double-bracket an already bracketed host', () => {
    expect(buildMetadataDsn(input({ host: '[::1]' }))).toContain('[::1]:5432')
  })

  it('trims surrounding whitespace on pasted values', () => {
    const dsn = buildMetadataDsn(input({ host: '  db.example.com  ', username: ' pgforge ' }))
    expect(dsn).toBe('postgresql://pgforge:secret@db.example.com:5432/pgforge?sslmode=require')
  })

  it('falls back to 5432 for an unusable port', () => {
    expect(buildMetadataDsn(input({ port: Number.NaN }))).toContain(':5432/')
    expect(buildMetadataDsn(input({ port: 0 }))).toContain(':5432/')
  })

  it('carries every ssl mode through', () => {
    for (const mode of ['disable', 'require', 'verify-ca', 'verify-full'] as const) {
      expect(buildMetadataDsn(input({ sslMode: mode }))).toContain(`sslmode=${mode}`)
    }
  })
})

describe('parseMetadataDsn', () => {
  it('round-trips the fields, minus the password', () => {
    const parsed = parseMetadataDsn(buildMetadataDsn(input()))
    expect(parsed).toEqual({
      host: 'db.example.com',
      port: 5432,
      database: 'pgforge',
      username: 'pgforge',
      sslMode: 'require',
    })
  })

  it('round-trips values that needed escaping', () => {
    const parsed = parseMetadataDsn(
      buildMetadataDsn(input({ username: 'user@corp', database: 'my db' })),
    )
    expect(parsed?.username).toBe('user@corp')
    expect(parsed?.database).toBe('my db')
  })

  it('round-trips an IPv6 host without its brackets', () => {
    expect(parseMetadataDsn(buildMetadataDsn(input({ host: '::1' })))?.host).toBe('::1')
  })

  it('accepts the postgres:// spelling', () => {
    expect(parseMetadataDsn('postgres://u:p@h:5432/db')?.database).toBe('db')
  })

  it('defaults a missing port to 5432', () => {
    expect(parseMetadataDsn('postgresql://u:p@h/db')?.port).toBe(5432)
  })

  it('reports a missing sslmode as disable, which is what happens', () => {
    expect(parseMetadataDsn('postgresql://u:p@h:5432/db')?.sslMode).toBe('disable')
  })

  it('ignores an unrecognised sslmode rather than passing it on', () => {
    expect(parseMetadataDsn('postgresql://u:p@h/db?sslmode=banana')?.sslMode).toBe('disable')
  })

  it('rejects a non-PostgreSQL scheme', () => {
    expect(parseMetadataDsn('mysql://u:p@h/db')).toBeNull()
    expect(parseMetadataDsn('https://example.com')).toBeNull()
  })

  it('rejects nonsense instead of throwing', () => {
    expect(parseMetadataDsn('not a url')).toBeNull()
    expect(parseMetadataDsn('')).toBeNull()
  })
})
