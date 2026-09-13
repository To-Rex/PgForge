import { hkdfSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../../core/crypto.js'
import { MetaStore } from '../../infra/store.js'
import { ConnectionsRepo, type ConnectionRecord } from './connections.repo.js'

/**
 * Registered PostgreSQL servers are the thing operators most expect to survive
 * a redeploy, so this walks the whole path: insert, snapshot, restore, read
 * back, decrypt.
 *
 * It also pins down the failure mode that looks identical from the outside but
 * is not the store's fault — a different APP_SECRET. The rows come back; the
 * passwords inside them do not.
 */

let dir: string

const keyFrom = (secret: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), 'pgforge/credentials', 32))

const SECRET_A = 'a-secret-long-enough-to-be-valid-1234'
const SECRET_B = 'a-different-secret-just-as-long-5678'

const record = (key: Buffer, over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  id: 'conn-1',
  name: 'Production',
  host: 'db.example.com',
  port: 5432,
  username: 'app',
  passwordEnc: encryptSecret('s3cret-p@ss', key),
  defaultDatabase: 'app',
  sslMode: 'require',
  color: null,
  readOnly: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  ...over,
})

const storePath = (name: string) => path.join(dir, name, 'pgforge.db')

const restore = (name: string, bytes: Buffer): string => {
  const target = storePath(name)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pgforge-conn-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('connections survive a snapshot round-trip', () => {
  it('signals a change, so the snapshot is scheduled', () => {
    let changes = 0
    const store = new MetaStore(storePath('a'), () => (changes += 1))
    new ConnectionsRepo(store).insert(record(keyFrom(SECRET_A)))
    expect(changes).toBe(1)
    store.close()
  })

  it('restores the connection with every field intact', () => {
    const key = keyFrom(SECRET_A)
    const source = new MetaStore(storePath('a'))
    new ConnectionsRepo(source).insert(record(key))
    const bytes = source.snapshot()
    source.close()

    const restored = new MetaStore(restore('b', bytes))
    const found = new ConnectionsRepo(restored).byId('conn-1')
    restored.close()

    expect(found).toMatchObject({
      name: 'Production',
      host: 'db.example.com',
      port: 5432,
      username: 'app',
      defaultDatabase: 'app',
      sslMode: 'require',
      readOnly: false,
    })
  })

  it('keeps the password readable under the same APP_SECRET', () => {
    const key = keyFrom(SECRET_A)
    const source = new MetaStore(storePath('a'))
    new ConnectionsRepo(source).insert(record(key))
    const bytes = source.snapshot()
    source.close()

    const restored = new MetaStore(restore('b', bytes))
    const found = new ConnectionsRepo(restored).byId('conn-1')!
    restored.close()

    expect(decryptSecret(found.passwordEnc, key)).toBe('s3cret-p@ss')
  })

  it('loses the password under a different APP_SECRET, though the row survives', () => {
    const source = new MetaStore(storePath('a'))
    new ConnectionsRepo(source).insert(record(keyFrom(SECRET_A)))
    const bytes = source.snapshot()
    source.close()

    const restored = new MetaStore(restore('b', bytes))
    const found = new ConnectionsRepo(restored).byId('conn-1')!
    restored.close()

    // This is the redeploy failure people report as "my connections are gone":
    // the connection is listed, but unusable until the password is re-entered.
    expect(found.name).toBe('Production')
    expect(() => decryptSecret(found.passwordEnc, keyFrom(SECRET_B))).toThrow()
  })

  it('restores several connections, not just the last one', () => {
    const key = keyFrom(SECRET_A)
    const source = new MetaStore(storePath('a'))
    const repo = new ConnectionsRepo(source)
    repo.insert(record(key, { id: 'c1', name: 'One' }))
    repo.insert(record(key, { id: 'c2', name: 'Two' }))
    repo.insert(record(key, { id: 'c3', name: 'Three' }))
    const bytes = source.snapshot()
    source.close()

    const restored = new MetaStore(restore('b', bytes))
    const names = new ConnectionsRepo(restored).list().map((c) => c.name)
    restored.close()

    expect(names.sort()).toEqual(['One', 'Three', 'Two'])
  })

  it('carries an update made after an earlier snapshot', () => {
    const key = keyFrom(SECRET_A)
    const source = new MetaStore(storePath('a'))
    const repo = new ConnectionsRepo(source)
    repo.insert(record(key))
    source.snapshot()
    repo.update(record(key, { name: 'Renamed', updatedAt: '2026-02-02T00:00:00.000Z' }))
    const bytes = source.snapshot()
    source.close()

    const restored = new MetaStore(restore('b', bytes))
    const found = new ConnectionsRepo(restored).byId('conn-1')
    restored.close()

    expect(found?.name).toBe('Renamed')
  })

  it('carries a deletion too', () => {
    const key = keyFrom(SECRET_A)
    const source = new MetaStore(storePath('a'))
    const repo = new ConnectionsRepo(source)
    repo.insert(record(key))
    source.snapshot()
    repo.delete('conn-1')
    const bytes = source.snapshot()
    source.close()

    const restored = new MetaStore(restore('b', bytes))
    const remaining = new ConnectionsRepo(restored).list()
    restored.close()

    expect(remaining).toEqual([])
  })
})
