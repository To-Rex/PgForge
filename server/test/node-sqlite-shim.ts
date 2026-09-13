import { createRequire } from 'node:module'

/**
 * Test-only stand-in for `node:sqlite`.
 *
 * `node:sqlite` is a prefix-only builtin: Node lists it as "node:sqlite" and
 * plain "sqlite" does not exist. Vite strips the prefix before deciding what is
 * built in, then fails looking for a package named "sqlite". Reaching the
 * module through `createRequire` sidesteps Vite's resolution entirely.
 *
 * Only vitest.config.ts aliases to this file; the server imports the builtin
 * directly, as it should.
 */
const require = createRequire(import.meta.url)
const sqlite = require('node:sqlite') as typeof import('node:sqlite')

export const { DatabaseSync, StatementSync, constants, backup } = sqlite
export default sqlite
