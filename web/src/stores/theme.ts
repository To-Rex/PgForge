import { create } from 'zustand'

export type Theme = 'dark' | 'light'

function initialTheme(): Theme {
  const current = document.documentElement.dataset.theme
  return current === 'light' ? 'light' : 'dark'
}

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggle: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('pgforge.theme', theme)
    } catch {
      /* storage unavailable */
    }
    set({ theme })
  },
  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}))
