/**
 * Bootstrap-pairing secret rules. Dependency-free so env.ts can enforce the
 * length rule at boot without pulling in the pool (which itself reads env).
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/** Below this the secret is guessable enough that we refuse to serve it. */
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32

export function bootstrapTokenError(token: string): string | null {
  if (!token) return null
  if (token.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
    return `PERSONAL_BOOTSTRAP_TOKEN must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters (e.g. \`openssl rand -hex 32\`)`
  }
  return null
}

/** Constant-time comparison. Hashing first gives both sides the same length,
 *  so the comparison itself never leaks the secret's length either. */
export function bootstrapTokenMatches(expected: string, given: string): boolean {
  if (!expected || !given) return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(given).digest()
  return timingSafeEqual(a, b)
}
