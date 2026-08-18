import type { AppUser } from '@pgforge/shared'
import { create } from 'zustand'

interface AuthState {
  user: AppUser | null
  /** True once the initial silent-refresh attempt has settled. */
  ready: boolean
  setUser: (user: AppUser | null) => void
  setReady: () => void
  clear: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  ready: false,
  setUser: (user) => set({ user }),
  setReady: () => set({ ready: true }),
  clear: () => set({ user: null }),
}))
