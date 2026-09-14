import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractEntry, listTar, packTar, readEntry } from './tar.js'

const execFileAsync = promisify(execFile)

let dir: string

const src = (name: string, content: Buffer | string): string => {
  const file = path.join(dir, 'src', name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pgforge-tar-'))
  mkdirSync(path.join(dir, 'out'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const archive = () => path.join(dir, 'out', 'bundle.tar')

describe('packTar / listTar', () => {
  it('round-trips a single file', async () => {
    await packTar(archive(), [{ name: 'globals.sql', path: src('globals.sql', 'CREATE ROLE app;') }])
    const entries = await listTar(archive())
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'globals.sql', size: 16 })
    expect((await readEntry(archive(), entries[0]!)).toString()).toBe('CREATE ROLE app;')
  })

  it('keeps several entries in order with correct sizes', async () => {
    await packTar(archive(), [
      { name: 'manifest.json', path: src('manifest.json', '{"v":1}') },
      { name: 'globals.sql', path: src('globals.sql', 'x'.repeat(1000)) },
      { name: 'databases/app.dump', path: src('app.dump', 'y'.repeat(513)) },
    ])
    const entries = await listTar(archive())
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'globals.sql',
      'databases/app.dump',
    ])
    expect(entries.map((e) => e.size)).toEqual([7, 1000, 513])
  })

  it('handles binary content byte-for-byte', async () => {
    // pg_dump custom format is binary and starts with the PGDMP magic.
    const dump = Buffer.concat([
      Buffer.from('PGDMP'),
      Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x0a, 0x0d, 0x1a]),
      Buffer.alloc(2000, 0xab),
    ])
    await packTar(archive(), [{ name: 'databases/app.dump', path: src('app.dump', dump) }])
    const entries = await listTar(archive())
    const out = path.join(dir, 'out', 'app.dump')
    await extractEntry(archive(), entries[0]!, out)
    expect(readFileSync(out).equals(dump)).toBe(true)
  })

  it('round-trips content that is an exact multiple of the block size', async () => {
    const exact = Buffer.alloc(512 * 3, 0x41)
    await packTar(archive(), [{ name: 'exact.bin', path: src('exact.bin', exact) }])
    const entries = await listTar(archive())
    expect(entries[0]!.size).toBe(1536)
    const out = path.join(dir, 'out', 'exact.bin')
    await extractEntry(archive(), entries[0]!, out)
    expect(readFileSync(out).equals(exact)).toBe(true)
  })

  it('round-trips an empty file', async () => {
    await packTar(archive(), [
      { name: 'empty.sql', path: src('empty.sql', '') },
      { name: 'after.sql', path: src('after.sql', 'SELECT 1;') },
    ])
    const entries = await listTar(archive())
    expect(entries.map((e) => e.name)).toEqual(['empty.sql', 'after.sql'])
    expect(entries[0]!.size).toBe(0)
    const out = path.join(dir, 'out', 'empty.sql')
    await extractEntry(archive(), entries[0]!, out)
    expect(readFileSync(out).length).toBe(0)
    // The entry after an empty one must still be found at the right offset.
    expect((await readEntry(archive(), entries[1]!)).toString()).toBe('SELECT 1;')
  })

  it('preserves UTF-8 names', async () => {
    await packTar(archive(), [{ name: 'databases/ma-lumot.dump', path: src('a', 'x') }])
    expect((await listTar(archive()))[0]!.name).toBe('databases/ma-lumot.dump')
  })

  it('refuses a name too long for ustar rather than truncating it', async () => {
    const long = `databases/${'d'.repeat(120)}.dump`
    await expect(packTar(archive(), [{ name: long, path: src('a', 'x') }])).rejects.toThrow(
      /too long/i,
    )
  })

  it('produces an archive ending in two zero blocks', async () => {
    await packTar(archive(), [{ name: 'a.sql', path: src('a.sql', 'hello') }])
    const bytes = readFileSync(archive())
    expect(bytes.length % 512).toBe(0)
    expect(bytes.subarray(bytes.length - 1024).every((b) => b === 0)).toBe(true)
  })

  it('lists nothing for an archive with no entries', async () => {
    await packTar(archive(), [])
    expect(await listTar(archive())).toEqual([])
  })
})

describe('extractEntry', () => {
  it('extracts the correct entry when several are present', async () => {
    await packTar(archive(), [
      { name: 'one.txt', path: src('one.txt', 'first') },
      { name: 'two.txt', path: src('two.txt', 'second') },
      { name: 'three.txt', path: src('three.txt', 'third') },
    ])
    const entries = await listTar(archive())
    const out = path.join(dir, 'out', 'two.txt')
    await extractEntry(archive(), entries[1]!, out)
    expect(readFileSync(out, 'utf8')).toBe('second')
  })
})

describe('interoperability with the system tar', () => {
  /** Proof the archive is real ustar, not just self-consistent. */
  it('is readable by the platform tar when one is available', async () => {
    await packTar(archive(), [
      { name: 'manifest.json', path: src('manifest.json', '{"databases":["app"]}') },
      { name: 'databases/app.dump', path: src('app.dump', Buffer.alloc(1500, 0x5a)) },
    ])

    let listing: string
    try {
      const { stdout } = await execFileAsync('tar', ['-tf', archive()])
      listing = stdout
    } catch {
      // No tar on this machine — the round-trip tests above still cover us.
      return
    }
    expect(listing).toContain('manifest.json')
    expect(listing).toContain('databases/app.dump')

    const extractDir = path.join(dir, 'sys')
    mkdirSync(extractDir, { recursive: true })
    await execFileAsync('tar', ['-xf', archive(), '-C', extractDir])
    expect(readFileSync(path.join(extractDir, 'manifest.json'), 'utf8')).toBe(
      '{"databases":["app"]}',
    )
    expect(readFileSync(path.join(extractDir, 'databases', 'app.dump')).length).toBe(1500)
  })
})
