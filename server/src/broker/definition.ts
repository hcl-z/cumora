/**
 * The shape of a declarative HTTP connector and the pure rules around it,
 * shared by the server (which parses and stores definitions) and the daemon's
 * Broker (which executes them). No dependencies, so the daemon bundle stays
 * small: YAML parsing lives server-side in personal/connector-schema.ts.
 */

export type ParamType = 'string' | 'number' | 'integer' | 'boolean'
export type Effect = 'read' | 'write'
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
/** Methods with no request body and, by HTTP semantics, no side effect. */
export const SAFE_METHODS: readonly HttpMethod[] = ['GET', 'HEAD']

export interface ParamSpec { type: ParamType; required: boolean; description?: string }

export interface ConnectorAction {
  id: string
  effect: Effect
  method: HttpMethod
  /** Starts with '/'; `{name}` segments are filled from params. */
  path: string
  params: Record<string, ParamSpec>
  description?: string
}

/** Where the daemon puts a vault credential on every call. The definition
 *  only names the credential; its value never leaves the daemon's vault. */
export type ConnectorAuth =
  | { type: 'header'; name: string; credential: string }
  | { type: 'bearer'; credential: string }
  | { type: 'query'; name: string; credential: string }

export interface ConnectorDefinition {
  slug: string
  kind: 'http'
  name?: string
  description?: string
  baseUrl: string
  rateLimitPerMinute: number
  auth?: ConnectorAuth
  actions: ConnectorAction[]
}

export const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
export const CREDENTIAL_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/
/** Headers a connector may not set: they would let a definition steer the
 *  request itself rather than authenticate it. */
export const FORBIDDEN_AUTH_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'cookie', 'te', 'upgrade',
  'proxy-authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip',
])

/** Header or query name the credential is sent under, or null for none. */
export function authTarget(auth: ConnectorAuth | undefined): { header?: string; query?: string } | null {
  if (!auth) return null
  if (auth.type === 'bearer') return { header: 'Authorization' }
  if (auth.type === 'header') return { header: auth.name }
  return { query: auth.name }
}

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60
export const SLUG_RE = /^[a-z][a-z0-9-]{1,47}$/
export const ACTION_ID_RE = /^[a-z][a-z0-9_]{0,47}$/
export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** `<connector slug>.<action id>` → its two parts, or null. */
export function splitActionName(name: string): { slug: string; actionId: string } | null {
  const dot = name.indexOf('.')
  if (dot <= 0) return null
  const slug = name.slice(0, dot)
  const actionId = name.slice(dot + 1)
  return SLUG_RE.test(slug) && ACTION_ID_RE.test(actionId) ? { slug, actionId } : null
}

/** Names of the `{param}` segments in a path. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1])
}

/** A JSON Schema the model sees for an action's params. */
export function paramsJsonSchema(action: ConnectorAction): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(action.params)) {
    properties[name] = { type: spec.type, ...(spec.description ? { description: spec.description } : {}) }
    if (spec.required) required.push(name)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Check model-supplied args against an action's params; returns the problems. */
export function validateArgs(action: ConnectorAction, args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['args must be an object']
  const record = args as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(record)) {
    if (!(key in action.params)) problems.push(`unknown param: ${key}`)
  }
  for (const [name, spec] of Object.entries(action.params)) {
    const v = record[name]
    if (v === undefined || v === null) {
      if (spec.required) problems.push(`missing required param: ${name}`)
      continue
    }
    const ok = spec.type === 'string' ? typeof v === 'string'
      : spec.type === 'boolean' ? typeof v === 'boolean'
      : spec.type === 'integer' ? typeof v === 'number' && Number.isInteger(v)
      : typeof v === 'number' && Number.isFinite(v)
    if (!ok) problems.push(`param ${name} must be ${spec.type}`)
  }
  return problems
}

/** The first `maxBytes` of a UTF-8 string, never splitting a character. */
export function cutUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return { text, cut: false }
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return { text: buf.subarray(0, end).toString('utf8'), cut: true }
}

/** How much of a console test call's response is shown (frontend §3.2). */
export const TEST_PREVIEW_BYTES = 2048

export interface ConnectorTestResult {
  status: number
  contentType: string | null
  durationMs: number
  /** Size of the whole response body. */
  bytes: number
  /** The first TEST_PREVIEW_BYTES of the body, credentials redacted. */
  preview: string
  truncated: boolean
}

export interface BuiltRequest { url: URL; method: HttpMethod; body: string | null; headers: Record<string, string> }

/** The concrete request for a validated call. Path params are URL-encoded so
 *  a value cannot add segments; the rest go in the query string for
 *  GET/HEAD/DELETE and in a JSON body otherwise. `credential` is the vault
 *  value for `def.auth`, applied last so an arg cannot override it. */
export function buildRequest(def: ConnectorDefinition, action: ConnectorAction, args: Record<string, unknown>, credential?: string | null): BuiltRequest {
  const inPath = new Set(pathParams(action.path))
  const path = action.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => encodeURIComponent(String(args[name] ?? '')))
  const base = def.baseUrl.replace(/\/+$/, '')
  const url = new URL(base + path)
  if (!url.href.startsWith(`${base}/`) && url.href !== base) throw new Error('action path escapes the connector base URL')
  const rest = Object.entries(args).filter(([k, v]) => !inPath.has(k) && v !== undefined && v !== null)
  let body: string | null = null
  if (action.method === 'GET' || action.method === 'HEAD' || action.method === 'DELETE') {
    for (const [k, v] of rest) url.searchParams.set(k, String(v))
  } else {
    body = JSON.stringify(Object.fromEntries(rest))
  }
  const headers: Record<string, string> = {}
  if (def.auth) {
    if (!credential) throw new Error(`credential ${def.auth.credential} is not set`)
    if (def.auth.type === 'bearer') headers.Authorization = `Bearer ${credential}`
    else if (def.auth.type === 'header') headers[def.auth.name] = credential
    else url.searchParams.set(def.auth.name, credential)
  }
  return { url, method: action.method, body, headers }
}

// ── address policy ──────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

function inV4Range(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0)
}

/** Expand an IPv6 literal to eight 16-bit groups, or null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes its two hex groups.
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const n = ipv4ToInt(v4[2])
    if (n === null) return null
    s = `${v4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (h: string) => (h ? h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : [])
  const head = parse(halves[0])
  const back = halves.length === 2 ? parse(halves[1]) : []
  if (halves.length === 2 && head.length + back.length > 7) return null
  const groups = halves.length === 2
    ? [...head, ...Array(8 - head.length - back.length).fill(0), ...back]
    : head
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/** True for any address an outbound connector call must never reach:
 *  loopback, private, link-local, CGNAT, multicast, documentation and
 *  reserved ranges, and their IPv4-mapped IPv6 forms. Unparseable input is
 *  treated as blocked. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip)
  if (v4 !== null) return V4_BLOCKED.some(([base, bits]) => inV4Range(v4, base, bits))
  const g = ipv6Groups(ip)
  if (!g) return true
  if (g.every((x) => x === 0)) return true                              // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true    // ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateAddress(`${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`) // ::ffff:a.b.c.d, ::a.b.c.d
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true                     // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true                           // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true                           // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true                           // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true                   // documentation
  return false
}

export function isLoopbackAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip)
  if (v4 !== null) return inV4Range(v4, '127.0.0.0', 8)
  const g = ipv6Groups(ip)
  return !!g && g.slice(0, 7).every((x) => x === 0) && g[7] === 1
}
