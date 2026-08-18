import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from './crypto.js'

describe('secret encryption', () => {
  const key = randomBytes(32)

  it('round-trips arbitrary strings', () => {
    for (const secret of ['p@ss', '', 'жуда махфий', '𝓾𝓷𝓲𝓬𝓸𝓭𝓮 🔐', 'a'.repeat(4096)]) {
      expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret)
    }
  })

  it('produces unique ciphertexts per call (fresh IV)', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key))
  })

  it('rejects tampered payloads', () => {
    const payload = encryptSecret('secret', key)
    const parts = payload.split('.')
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]!.slice(0, -2)}AA`].join('.')
    expect(() => decryptSecret(tampered, key)).toThrow()
  })

  it('rejects the wrong key', () => {
    const payload = encryptSecret('secret', key)
    expect(() => decryptSecret(payload, randomBytes(32))).toThrow()
  })
})

describe('password hashing', () => {
  it('verifies correct passwords and rejects wrong ones', () => {
    const hash = hashPassword('correct horse battery staple')
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(verifyPassword('correct horse battery stapl', hash)).toBe(false)
  })

  it('rejects malformed stored hashes without throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(verifyPassword('x', 'scrypt$bad$8$1$c2FsdA$aGFzaA')).toBe(false)
  })
})
