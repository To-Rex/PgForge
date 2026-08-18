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
