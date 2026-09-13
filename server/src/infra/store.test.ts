import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MetaStore } from './store.js'

/**
 * These cover the mechanism the PostgreSQL metadata backend rests on: the
 * bytes `snapshot()` returns must reopen as the very same database, or a
 * redeploy would restore a corrupt store.
 */

let dir: string

const storePath = (name: string) => path.join(dir, name, 'pgforge.db')

/** Mirrors the restore path in index.ts: the directory exists before the write. */
const restore = (name: string, bytes: Buffer): string => {
  const target = storePath(name)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

const seedUser = (store: MetaStore, email: string) =>
  store.run(
    `INSERT INTO users (id, email, name, role, password_hash, created_at)
     VALUES (:id, :email, :name, 'admin', 'hash', '2026-01-01T00:00:00.000Z')`,
    { id: email, email, name: 'Test' },
  )

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pgforge-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('MetaStore snapshot/restore', () => {
  it('reopens a snapshot as the same database', () => {
    const source = new MetaStore(storePath('a'))
    seedUser(source, 'admin@example.com')
    const bytes = source.snapshot()
    source.close()

    const restored = new MetaStore(restore('b', bytes))
    const row = restored.get<{ email: string }>('SELECT email FROM users')
    restored.close()

    expect(row?.email).toBe('admin@example.com')
  })

  it('produces a real SQLite image', () => {
    const store = new MetaStore(storePath('a'))
    const bytes = store.snapshot()
    store.close()
    expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3')
  })

  it('carries the migration version across, so no migration re-runs', () => {
    const source = new MetaStore(storePath('a'))
    const bytes = source.snapshot()
    source.close()

    const target = restore('b', bytes)
    // Opening runs migrate(); a lost user_version would replay v1 and throw on
    // the already-existing tables.
    expect(() => new MetaStore(target).close()).not.toThrow()
  })

  it('includes writes made after the previous snapshot', () => {
    const source = new MetaStore(storePath('a'))
    seedUser(source, 'first@example.com')
    source.snapshot()
    seedUser(source, 'second@example.com')
    const bytes = source.snapshot()
    source.close()

    const restored = new MetaStore(restore('b', bytes))
    const count = restored.get<{ n: number }>('SELECT count(*) AS n FROM users')
    restored.close()

    expect(count?.n).toBe(2)
  })

  it('survives repeated snapshots of an unchanged database', () => {
    const store = new MetaStore(storePath('a'))
    seedUser(store, 'a@example.com')
    const first = store.snapshot()
    const second = store.snapshot()
    store.close()
    expect(second.length).toBe(first.length)
  })

  it('refuses to snapshot an in-memory store', () => {
    const store = new MetaStore(':memory:')
    expect(() => store.snapshot()).toThrow(/in-memory/i)
    store.close()
  })

  it('reports the on-disk size', () => {
    const store = new MetaStore(storePath('a'))
    seedUser(store, 'a@example.com')
    store.snapshot()
    expect(store.byteSize()).toBeGreaterThan(0)
    store.close()
  })
})

describe('MetaStore change notification', () => {
  it('fires on writes', () => {
    let changes = 0
    const store = new MetaStore(storePath('a'), () => (changes += 1))
    seedUser(store, 'a@example.com')
    expect(changes).toBe(1)
    seedUser(store, 'b@example.com')
    expect(changes).toBe(2)
    store.close()
  })

  it('does not fire on reads', () => {
    let changes = 0
    const store = new MetaStore(storePath('a'), () => (changes += 1))
    store.all('SELECT * FROM users')
    store.get('SELECT * FROM users')
    expect(changes).toBe(0)
    store.close()
  })

  it('fires on a factory reset so the wipe is replicated too', () => {
    let changes = 0
    const store = new MetaStore(storePath('a'), () => (changes += 1))
    seedUser(store, 'a@example.com')
    changes = 0
    store.wipeAll()
    expect(changes).toBe(1)
    expect(store.get<{ n: number }>('SELECT count(*) AS n FROM users')?.n).toBe(0)
    store.close()
  })

  it('works without a listener, exactly as before', () => {
    const store = new MetaStore(storePath('a'))
    expect(() => seedUser(store, 'a@example.com')).not.toThrow()
    store.close()
  })
})
