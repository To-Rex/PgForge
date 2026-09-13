import { defineConfig } from 'vitest/config'

// Only pure modules are covered here — no DOM, no component rendering — so the
// suite stays fast enough to run on every change. Anything needing a browser
// belongs in an end-to-end suite, not this one.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
