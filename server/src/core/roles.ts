import type { AppRole } from '@pgforge/shared'

const ROLE_LEVEL: Record<AppRole, number> = { viewer: 0, editor: 1, admin: 2 }

export function hasRole(actual: AppRole, required: AppRole): boolean {
  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required]
}
