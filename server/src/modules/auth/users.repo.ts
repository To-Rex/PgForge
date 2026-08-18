import type { AppRole, AppUser } from '@pgforge/shared'
import type { MetaStore } from '../../infra/store.js'

export interface UserRecord {
  id: string
  email: string
  name: string
  role: AppRole
  passwordHash: string
  createdAt: string
  lastLoginAt: string | null
}

interface Row {
  id: string
  email: string
  name: string
  role: AppRole
  password_hash: string
  created_at: string
  last_login_at: string | null
}

const toRecord = (r: Row): UserRecord => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  passwordHash: r.password_hash,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
})

export const toAppUser = (u: UserRecord): AppUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
})

export class UsersRepo {
  constructor(private readonly store: MetaStore) {}

  count(): number {
    return this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0
  }

  list(): UserRecord[] {
    return this.store.all<Row>('SELECT * FROM users ORDER BY created_at').map(toRecord)
  }

  byId(id: string): UserRecord | undefined {
    const row = this.store.get<Row>('SELECT * FROM users WHERE id = :id', { id })
    return row ? toRecord(row) : undefined
  }

  byEmail(email: string): UserRecord | undefined {
    const row = this.store.get<Row>('SELECT * FROM users WHERE email = :email COLLATE NOCASE', {
      email,
    })
    return row ? toRecord(row) : undefined
  }

  insert(user: UserRecord): void {
    this.store.run(
      `INSERT INTO users (id, email, name, role, password_hash, created_at)
       VALUES (:id, :email, :name, :role, :passwordHash, :createdAt)`,
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash: user.passwordHash,
        createdAt: user.createdAt,
      },
    )
  }

  update(user: UserRecord): void {
    this.store.run(
      `UPDATE users SET email = :email, name = :name, role = :role, password_hash = :passwordHash
       WHERE id = :id`,
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash: user.passwordHash,
      },
    )
  }

  touchLogin(id: string, at: string): void {
    this.store.run('UPDATE users SET last_login_at = :at WHERE id = :id', { id, at })
  }

  delete(id: string): boolean {
    return this.store.run('DELETE FROM users WHERE id = :id', { id }).changes > 0
  }

  countAdmins(): number {
    return this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")?.n ?? 0
  }
}
