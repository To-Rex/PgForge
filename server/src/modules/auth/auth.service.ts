import { createHash } from 'node:crypto'
import { MIN_PASSWORD_LENGTH, type AppUser, type CreateUserInput, type SetupInput, type UpdateUserInput } from '@pgforge/shared'
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../../core/errors.js'
import { hashPassword, randomToken, verifyPassword } from '../../core/crypto.js'
import { newId, nowIso } from '../../core/util.js'
import type { MetaStore } from '../../infra/store.js'
import { toAppUser, UsersRepo, type UserRecord } from './users.repo.js'

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const THROTTLE_MAX_FAILURES = 5
const THROTTLE_WINDOW_MS = 5 * 60_000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** In-memory login throttle keyed by ip+email — resets on success. */
class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; lockedUntil: number }>()

  check(key: string): void {
    const entry = this.attempts.get(key)
    if (entry && entry.lockedUntil > Date.now()) {
      throw new UnauthorizedError('Too many failed attempts. Try again in a few minutes.')
    }
  }

  fail(key: string): void {
    const entry = this.attempts.get(key) ?? { count: 0, lockedUntil: 0 }
    entry.count += 1
    if (entry.count >= THROTTLE_MAX_FAILURES) {
      entry.lockedUntil = Date.now() + THROTTLE_WINDOW_MS
      entry.count = 0
    }
    this.attempts.set(key, entry)
  }

  succeed(key: string): void {
    this.attempts.delete(key)
  }
}

interface SessionRow {
  id: string
  user_id: string
  expires_at: string
}

export class AuthService {
  readonly users: UsersRepo
  private readonly throttle = new LoginThrottle()

  constructor(private readonly store: MetaStore) {
    this.users = new UsersRepo(store)
  }

  needsSetup(): boolean {
    return this.users.count() === 0
  }

  /** First-run only: creates the initial admin account. */
  setup(input: SetupInput): UserRecord {
    if (!this.needsSetup()) throw new ConflictError('Setup has already been completed')
    return this.createUserRecord(input.name, input.email, input.password, 'admin')
  }

  login(email: string, password: string, ip: string): UserRecord {
    const key = `${ip}|${email.toLowerCase()}`
    this.throttle.check(key)
    const user = this.users.byEmail(email)
    if (!user || !verifyPassword(password, user.passwordHash)) {
      this.throttle.fail(key)
      throw new UnauthorizedError('Invalid email or password')
    }
    this.throttle.succeed(key)
    this.users.touchLogin(user.id, nowIso())
    return user
  }

  issueRefreshToken(userId: string, ip: string, userAgent: string): string {
    const token = randomToken(32)
    this.store.run(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, ip, user_agent)
       VALUES (:id, :userId, :tokenHash, :createdAt, :expiresAt, :ip, :userAgent)`,
      {
        id: newId(),
        userId,
        tokenHash: sha256(token),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        ip,
        userAgent: userAgent.slice(0, 300),
      },
    )
    return token
  }

  /** Validates + rotates the refresh token (single use). */
  rotateRefreshToken(token: string, ip: string, userAgent: string): { user: UserRecord; token: string } {
    const row = this.store.get<SessionRow>(
      'SELECT id, user_id, expires_at FROM sessions WHERE token_hash = :hash',
      { hash: sha256(token) },
    )
    if (!row) throw new UnauthorizedError('Invalid session')
    this.store.run('DELETE FROM sessions WHERE id = :id', { id: row.id })
    if (row.expires_at < nowIso()) throw new UnauthorizedError('Session expired')
    const user = this.users.byId(row.user_id)
    if (!user) throw new UnauthorizedError('User no longer exists')
    return { user, token: this.issueRefreshToken(user.id, ip, userAgent) }
  }

  revokeRefreshToken(token: string): void {
    this.store.run('DELETE FROM sessions WHERE token_hash = :hash', { hash: sha256(token) })
  }

  listUsers(): AppUser[] {
    return this.users.list().map(toAppUser)
  }

  createUser(input: CreateUserInput): AppUser {
    return toAppUser(this.createUserRecord(input.name, input.email, input.password, input.role))
  }

  updateUser(id: string, input: UpdateUserInput): AppUser {
    const user = this.users.byId(id)
    if (!user) throw new NotFoundError('User not found')
    if (input.email && input.email.toLowerCase() !== user.email.toLowerCase()) {
      if (this.users.byEmail(input.email)) throw new ConflictError('Email already in use')
      user.email = input.email
    }
    if (input.role && input.role !== 'admin' && user.role === 'admin' && this.users.countAdmins() === 1) {
      throw new BadRequestError('Cannot demote the last administrator')
    }
    if (input.name) user.name = input.name
    if (input.role) user.role = input.role
    if (input.password) {
      this.validatePassword(input.password)
      user.passwordHash = hashPassword(input.password)
      // Password change invalidates existing sessions.
      this.store.run('DELETE FROM sessions WHERE user_id = :id', { id })
    }
    this.users.update(user)
    return toAppUser(user)
  }

  deleteUser(id: string, actingUserId: string): void {
    if (id === actingUserId) throw new BadRequestError('You cannot delete your own account')
    const user = this.users.byId(id)
    if (!user) throw new NotFoundError('User not found')
    if (user.role === 'admin' && this.users.countAdmins() === 1) {
      throw new BadRequestError('Cannot delete the last administrator')
    }
    this.users.delete(id)
  }

  private createUserRecord(name: string, email: string, password: string, role: UserRecord['role']): UserRecord {
    this.validatePassword(password)
    if (this.users.byEmail(email)) throw new ConflictError('Email already in use')
    const record: UserRecord = {
      id: newId(),
      email,
      name,
      role,
      passwordHash: hashPassword(password),
      createdAt: nowIso(),
      lastLoginAt: null,
    }
    this.users.insert(record)
    return record
  }

  private validatePassword(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`)
    }
  }
}
