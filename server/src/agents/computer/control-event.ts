/** Wire protocol shared by the API server and the standalone Computer daemon. */
import type { SealedCredential } from '../../broker/vault.js'

export type ComputerControlEvent =
  | { kind: 'engine.detect'; id: string; at: number }
  /** Store a browser-sealed credential. The server relays the sealed blob
   *  and never keeps it; only this daemon's ECDH key opens it. */
  | { kind: 'vault.put'; id: string; at: number; requestId: string; connector: string; name: string; sealed: SealedCredential }
  | { kind: 'vault.delete'; id: string; at: number; requestId: string; connector: string; name: string }

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export function parseComputerControlEvent(raw: string): ComputerControlEvent | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || !isStr(value.id) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null
    if (value.kind === 'engine.detect') return value as unknown as ComputerControlEvent
    if (value.kind !== 'vault.put' && value.kind !== 'vault.delete') return null
    if (!isStr(value.requestId) || !isStr(value.connector) || !isStr(value.name)) return null
    if (value.kind === 'vault.put') {
      const s = value.sealed as Record<string, unknown> | null
      if (!s || s.v !== 1 || typeof s.epk !== 'object' || s.epk === null || !isStr(s.iv) || !isStr(s.ct)) return null
    }
    return value as unknown as ComputerControlEvent
  } catch {
    return null
  }
}
