import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * `node:sqlite` is a prefix-only builtin: Node lists it as "node:sqlite", and
 * plain "sqlite" is not a module at all. Vite strips the prefix before deciding
 * what is built in, concludes there is a package called "sqlite", and fails to
 * load it — so any test that reaches the metadata store cannot even be
 * collected.
 *
 * The alias points at a shim that pulls the builtin in through `createRequire`,
 * out of Vite's reach. It applies to tests only; the server imports the builtin
 * directly.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^node:sqlite$/,
        replacement: path.resolve(import.meta.dirname, 'test/node-sqlite-shim.ts'),
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
