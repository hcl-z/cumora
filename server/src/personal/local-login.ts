/**
 * Local one-time login for personal-mode development (mvp-backend-design §2.3).
 *
 * A dev machine has no OAuth app, so the server prints a single-use link at
 * boot instead. The link is only safe because the server is reachable from
 * this machine alone: the boot gate refuses to start unless the listener is
 * pinned to a loopback address, and never in production.
 *
 * Pure module — no env/pool/redis imports — so the gate and the token rules
 * are unit-testable without booting the server.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const LOCAL_LOGIN_TTL_MS = 10 * 60_000

export interface LocalLoginConfig {
  enabled: boolean
  personalMode: boolean
  nodeEnv: string
  /** The address `server.listen` binds to; empty means all interfaces. */
  listenHost: string
}

/** Literal loopback addresses only. `localhost` is refused on purpose: its
 *  resolution is the host's business, and the gate must not depend on it. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === '::1' || h === '[::1]') return true
  return /^127(?:\.\d{1,3}){3}$/.test(h)
}

/** Reasons the server must refuse to boot. Empty when local login is off or
 *  safely configured. */
export function localLoginConfigErrors(cfg: LocalLoginConfig): string[] {
  if (!cfg.enabled) return []
  const errors: string[] = []
  if (!cfg.personalMode) errors.push('PERSONAL_LOCAL_LOGIN requires PERSONAL_MODE=1')
  if (cfg.nodeEnv === 'production') errors.push('PERSONAL_LOCAL_LOGIN is refused when NODE_ENV=production')
  if (!isLoopbackHost(cfg.listenHost)) {
    errors.push(`PERSONAL_LOCAL_LOGIN requires LISTEN_HOST to be a loopback address (got "${cfg.listenHost || 'all interfaces'}")`)
  }
  return errors
}

/** One outstanding login token at a time. Issuing replaces the previous one;
 *  consuming succeeds at most once and only before the TTL elapses. */
export class LocalLoginTokens {
  private token: Buffer | null = null
  private expiresAt = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = LOCAL_LOGIN_TTL_MS,
  ) {}

  issue(): string {
    const raw = randomBytes(32)
    this.token = raw
    this.expiresAt = this.now() + this.ttlMs
    return raw.toString('base64url')
  }

  consume(candidate: string): boolean {
    const held = this.token
    if (!held) return false
    if (this.now() >= this.expiresAt) {
      this.token = null
      return false
    }
    const given = Buffer.from(candidate, 'base64url')
    if (given.length !== held.length || !timingSafeEqual(given, held)) return false
    this.token = null
    return true
  }
}

/** The renderer consumes `#login=` and exchanges it for a session; the token
 *  rides the fragment so it never reaches a server or proxy log. */
export function localLoginUrl(rendererBase: string, token: string): string {
  return `${rendererBase.replace(/#.*$/, '')}#${new URLSearchParams({ login: token }).toString()}`
}
