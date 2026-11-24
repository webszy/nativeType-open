/** Presented keys longer than this are rejected before hashing or storage. */
export const LICENSE_KEY_MAX_LENGTH = 80

const legacyBodyPattern = /^[A-Z2-7]{32}$/
const crockfordBodyPattern = /^[0-9A-HJKMNP-TV-Z]{20}$/

function grouped(body: string): string {
  let canonical = 'NT'
  for (let index = 0; index < body.length; index += 4) canonical += `-${body.slice(index, index + 4)}`
  return canonical
}

/**
 * Canonical text hashed and compared for both key versions.
 * A 32-character RFC 4648 body is a legacy key: I, L, O, and U stay unchanged.
 * Crockford substitutions apply only to a 20-character body, after that check.
 */
export function normalizeLicenseKey(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > LICENSE_KEY_MAX_LENGTH) return null
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '')
  if (!compact.startsWith('NT')) return null
  const body = compact.slice(2)
  if (legacyBodyPattern.test(body)) return grouped(body)
  if (body.length !== 20) return null
  const mapped = body.replace(/[ILO]/g, character => character === 'O' ? '0' : '1')
  if (!crockfordBodyPattern.test(mapped)) return null
  return grouped(mapped)
}

/** SHA-256 of the canonical UTF-8 key, shared by server verification and the account fingerprint. */
export async function hashLicenseKey(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Display-only fingerprint. Never persist or log characters taken from the credential itself. */
export function licenseKeyHints(keyHash: string): { prefix: string, last4: string } {
  return { prefix: `NT-${keyHash.slice(0, 4).toUpperCase()}`, last4: keyHash.slice(-4).toUpperCase() }
}
