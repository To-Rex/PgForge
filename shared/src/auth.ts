/** Platform-level access roles (not PostgreSQL roles). */
export type AppRole = 'admin' | 'editor' | 'viewer'

export interface AppUser {
  id: string
  email: string
  name: string
  role: AppRole
  createdAt: string
  lastLoginAt: string | null
}

export interface LoginInput {
  email: string
  password: string
}

export interface SetupInput {
  name: string
  email: string
  password: string
}

export interface AuthResponse {
  token: string
  user: AppUser
}

export interface BootstrapInfo {
  needsSetup: boolean
}

export interface CreateUserInput {
  name: string
  email: string
  password: string
  role: AppRole
}

export interface UpdateUserInput {
  name?: string
  email?: string
  password?: string
  role?: AppRole
}

// ── Invitations ─────────────────────────────────────────────────────────────

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked'

export interface Invitation {
  id: string
  email: string
  role: AppRole
  status: InvitationStatus
  invitedBy: string | null
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
  /** Whether the invitation email was delivered (false = share the link manually). */
  emailSent: boolean
}

export interface CreateInvitationInput {
  email: string
  role: AppRole
}

/** Returned once on creation — the raw token is never stored or shown again. */
export interface CreatedInvitation {
  invitation: Invitation
  acceptUrl: string
  emailSent: boolean
  emailError: string | null
}

/** Public view for the accept page (no secrets). */
export interface InvitationPreview {
  valid: boolean
  email?: string
  role?: AppRole
  reason?: 'invalid' | 'expired' | 'used' | 'revoked'
}

export interface AcceptInvitationInput {
  token: string
  name: string
  password: string
}

/** Minimum password length for platform accounts (setup, users, invitations). */
export const MIN_PASSWORD_LENGTH = 8
