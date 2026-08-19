import { createHash } from 'node:crypto'
import {
  MIN_PASSWORD_LENGTH,
  type AcceptInvitationInput,
  type AppRole,
  type CreateInvitationInput,
  type Invitation,
  type InvitationPreview,
} from '@pgforge/shared'
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js'
import { hashPassword, randomToken } from '../../core/crypto.js'
import { newId, nowIso } from '../../core/util.js'
import type { MetaStore } from '../../infra/store.js'
import { UsersRepo, type UserRecord } from './users.repo.js'

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface Row {
  id: string
  email: string
  role: AppRole
  token_hash: string
  invited_by: string | null
  email_sent: number
  created_at: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
}

function toInvitation(r: Row): Invitation {
  const status: Invitation['status'] = r.accepted_at
    ? 'accepted'
    : r.revoked_at
      ? 'revoked'
      : r.expires_at < nowIso()
        ? 'expired'
        : 'pending'
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    status,
    invitedBy: r.invited_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    emailSent: r.email_sent === 1,
  }
}

/**
 * Single-use invitations. Only the SHA-256 of the token is stored, so a
 * database leak cannot be turned into working invite links. Re-issuing for
 * the same email revokes every earlier pending token for that address.
 */
export class InvitationsService {
  private readonly users: UsersRepo

  constructor(private readonly store: MetaStore) {
    this.users = new UsersRepo(store)
  }

  list(): Invitation[] {
    return this.store
      .all<Row>('SELECT * FROM invitations ORDER BY created_at DESC LIMIT 200')
      .map(toInvitation)
  }

  /** Returns the raw token exactly once; caller builds the URL and (maybe) emails it. */
  create(input: CreateInvitationInput, invitedBy: string): { invitation: Invitation; token: string } {
    const email = input.email.trim().toLowerCase()
    if (this.users.byEmail(email)) throw new ConflictError('A user with this email already exists')

    // One live invitation per address: previous pending ones die now.
    this.store.run(
      `UPDATE invitations SET revoked_at = :now
       WHERE email = :email AND accepted_at IS NULL AND revoked_at IS NULL`,
      { email, now: nowIso() },
    )

    const token = randomToken(32)
    const row: Row = {
      id: newId(),
      email,
      role: input.role,
      token_hash: sha256(token),
      invited_by: invitedBy,
      email_sent: 0,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      accepted_at: null,
      revoked_at: null,
    }
    this.store.run(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, email_sent, created_at, expires_at)
       VALUES (:id, :email, :role, :tokenHash, :invitedBy, 0, :createdAt, :expiresAt)`,
      {
        id: row.id,
        email: row.email,
        role: row.role,
        tokenHash: row.token_hash,
        invitedBy: row.invited_by,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      },
    )
    return { invitation: toInvitation(row), token }
  }

  markEmailSent(id: string): void {
    this.store.run('UPDATE invitations SET email_sent = 1 WHERE id = :id', { id })
  }

  revoke(id: string): void {
    const changed = this.store.run(
      `UPDATE invitations SET revoked_at = :now
       WHERE id = :id AND accepted_at IS NULL AND revoked_at IS NULL`,
      { id, now: nowIso() },
    ).changes
    if (changed === 0) throw new NotFoundError('Invitation not found or no longer pending')
  }

  preview(token: string): InvitationPreview {
    const row = this.store.get<Row>('SELECT * FROM invitations WHERE token_hash = :hash', {
      hash: sha256(token),
    })
    if (!row) return { valid: false, reason: 'invalid' }
    if (row.accepted_at) return { valid: false, reason: 'used' }
    if (row.revoked_at) return { valid: false, reason: 'revoked' }
    if (row.expires_at < nowIso()) return { valid: false, reason: 'expired' }
    return { valid: true, email: row.email, role: row.role }
  }

  /** Atomically consumes the token and creates the account. */
  accept(input: AcceptInvitationInput): UserRecord {
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`)
    }
    const hash = sha256(input.token)
    // The UPDATE's WHERE clause is the single-use guarantee: a second accept
    // with the same token matches zero rows, no matter how concurrent.
    const consumed = this.store.run(
      `UPDATE invitations SET accepted_at = :now
       WHERE token_hash = :hash AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > :now`,
      { hash, now: nowIso() },
    ).changes
    if (consumed === 0) {
      const state = this.preview(input.token)
      throw new BadRequestError(
        state.reason === 'used'
          ? 'This invitation link has already been used'
          : state.reason === 'expired'
            ? 'This invitation link has expired'
            : 'This invitation link is not valid',
      )
    }
    const row = this.store.get<Row>('SELECT * FROM invitations WHERE token_hash = :hash', { hash })!
    if (this.users.byEmail(row.email)) {
      throw new ConflictError('A user with this email already exists')
    }
    const record: UserRecord = {
      id: newId(),
      email: row.email,
      name: input.name.trim(),
      role: row.role,
      passwordHash: hashPassword(input.password),
      createdAt: nowIso(),
      lastLoginAt: null,
    }
    this.users.insert(record)
    return record
  }
}
