import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

const GCM_IV_BYTES = 12
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLen: 64, saltBytes: 16 }

/** AES-256-GCM for connection credentials at rest. Format: v1.<iv>.<tag>.<data> (base64url). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.')
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.')
  if (version !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error('Malformed encrypted payload')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** scrypt password hash. Format: scrypt$N$r$p$<salt>$<hash> (base64url). */
export function hashPassword(password: string): string {
  const { N, r, p, keyLen, saltBytes } = SCRYPT_PARAMS
  const salt = randomBytes(saltBytes)
  const hash = scryptSync(password, salt, keyLen, { N, r, p, maxmem: 128 * N * r * 2 })
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4]!, 'base64url')
  const expected = Buffer.from(parts[5]!, 'base64url')
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  const actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 })
  return timingSafeEqual(actual, expected)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
