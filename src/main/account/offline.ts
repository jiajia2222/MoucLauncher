/**
 * Offline-mode UUIDs, byte-for-byte compatible with Java's
 * `UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes("UTF-8"))`:
 * MD5 of the UTF-8 bytes, then stamp version 3 into byte 6 and the RFC 4122
 * variant (10xx) into byte 8, and format with dashes.
 */
import { md5Of } from '../core/fsx'

/** Vanilla username rule: A-Z a-z 0-9 underscore, 1..16 chars. */
export const OFFLINE_NAME_RE = /^[A-Za-z0-9_]{1,16}$/

export function offlineUuid(name: string): string {
  const digest = Buffer.from(md5Of(Buffer.from(`OfflinePlayer:${name}`, 'utf8')), 'hex')
  digest[6] = (digest[6]! & 0x0f) | 0x30 // version 3 (MD5)
  digest[8] = (digest[8]! & 0x3f) | 0x80 // IETF variant
  const hex = digest.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
