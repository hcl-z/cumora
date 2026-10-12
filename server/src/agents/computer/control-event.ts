/** Wire protocol shared by the API server and the standalone Computer daemon. */
import type { ConnectorDefinition } from '../../broker/definition.js'
import type { SealedCredential } from '../../broker/vault.js'

export type ComputerControlEvent =
  | { kind: 'engine.detect'; id: string; at: number }
  /** Store a browser-sealed credential. The server relays the sealed blob
   *  and never keeps it; only this daemon's ECDH key opens it. */
  | { kind: 'vault.put'; id: string; at: number; requestId: string; connector: string; name: string; sealed: SealedCredential }
  | { kind: 'vault.delete'; id: string; at: number; requestId: string; connector: string; name: string }
  /** Try one read action from the console. The call runs here because only
   *  this host holds the connector's credential. */
  | { kind: 'connector.test'; id: string; at: number; requestId: string; definition: ConnectorDefinition; action: string; args: Record<string, unknown> }

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function parseComputerControlEvent(raw: string): ComputerControlEvent | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || !isStr(value.id) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null
    if (value.kind === 'engine.detect') return value as unknown as ComputerControlEvent
    if (value.kind === 'connector.test') {
      if (!isStr(value.requestId) || !isStr(value.action) || !isObj(value.args)) return null
      const def = value.definition
      if (!isObj(def) || !isStr(def.slug) || !isStr(def.baseUrl) || !Array.isArray(def.actions)) return null
      return value as unknown as ComputerControlEvent
    }
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
