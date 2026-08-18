import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Shared package ships TS source; it must be bundled, not externalized.
  noExternal: ['@pgforge/shared'],
  // node:sqlite requires its prefix; tsup must not strip `node:` specifiers.
  removeNodeProtocol: false,
})
