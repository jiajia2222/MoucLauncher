import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { OFFLINE_NAME_RE, offlineUuid } from '../../src/main/account/offline'

/** Independent re-implementation of Java UUID.nameUUIDFromBytes as a cross-check. */
function javaNameUuid(name: string): string {
  const bytes = crypto.createHash('md5').update(Buffer.from(`OfflinePlayer:${name}`, 'utf8')).digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x30
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

describe('offlineUuid (OfflinePlayer: MD5, version 3, IETF variant)', () => {
  it('matches known vectors produced by Java UUID.nameUUIDFromBytes', () => {
    // Computed with the exact Java algorithm; these are stable per name.
    expect(offlineUuid('Steve')).toBe('5627dd98-e6be-3c21-b8a8-e92344183641')
    expect(offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f')
    expect(offlineUuid('abc')).toBe('3d5cec06-bd15-31fa-982f-5dac8c06f1c7')
  })

  it('is deterministic and case-sensitive', () => {
    expect(offlineUuid('Alex')).toBe(offlineUuid('Alex'))
    expect(offlineUuid('Alex')).not.toBe(offlineUuid('alex'))
    expect(offlineUuid('Alex')).toBe(javaNameUuid('Alex'))
  })

  it('formats with dashes, version nibble 3 and variant 10xx', () => {
    const uuid = offlineUuid('MoucTest')
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const bytes = Buffer.from(uuid.replace(/-/g, ''), 'hex')
    expect((bytes[6]! & 0xf0) >> 4).toBe(3) // version
    expect((bytes[8]! & 0xc0) >> 6).toBe(2) // variant 10
  })

  it('uses UTF-8 bytes for non-ASCII names', () => {
    expect(offlineUuid('玩家')).toBe(javaNameUuid('玩家'))
  })
})

describe('OFFLINE_NAME_RE', () => {
  it('accepts vanilla-legal names only', () => {
    expect(OFFLINE_NAME_RE.test('Steve_1')).toBe(true)
    expect(OFFLINE_NAME_RE.test('abcdefghijklmnop')).toBe(true)
    expect(OFFLINE_NAME_RE.test('')).toBe(false)
    expect(OFFLINE_NAME_RE.test('a'.repeat(17))).toBe(false)
    expect(OFFLINE_NAME_RE.test('bad name')).toBe(false)
    expect(OFFLINE_NAME_RE.test('玩家')).toBe(false)
  })
})
