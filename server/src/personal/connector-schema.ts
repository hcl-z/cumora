/**
 * Parse and validate a connector YAML into a ConnectorDefinition
 * (broker/definition.ts). Hand-written checks in the router's HttpError(400)
 * style: every problem is reported, not just the first.
 *
 * T08 scope: `kind: http` without auth. `auth` is rejected until the
 * credential vault (T09); `events` are accepted and ignored until event
 * triggers (T21).
 */
import yaml from 'js-yaml'
import {
  ACTION_ID_RE, CREDENTIAL_NAME_RE, type ConnectorAction, type ConnectorAuth, type ConnectorDefinition, DEFAULT_RATE_LIMIT_PER_MINUTE,
  FORBIDDEN_AUTH_HEADERS, HEADER_NAME_RE, HTTP_METHODS, type HttpMethod, PARAM_NAME_RE, type ParamSpec, type ParamType,
  SAFE_METHODS, SLUG_RE, pathParams,
} from '../broker/definition.js'

export const MAX_CONNECTOR_YAML_BYTES = 64 * 1024
const MAX_ACTIONS = 64
const MAX_PARAMS = 32
const PARAM_TYPES: readonly ParamType[] = ['string', 'number', 'integer', 'boolean']

export class ConnectorSchemaError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid connector: ${problems.join('; ')}`)
    this.name = 'ConnectorSchemaError'
  }
}

export interface ParseOptions {
  /** Accept http://127.0.0.1 / http://[::1] base URLs (local e2e only). */
  allowLoopbackHttp?: boolean
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function parseParam(name: string, raw: unknown, where: string, problems: string[]): ParamSpec | null {
  // Shorthand `symbol: string` / `limit: integer?`, or `{ type, required, description }`.
  if (typeof raw === 'string') {
    const optional = raw.endsWith('?')
    const type = (optional ? raw.slice(0, -1) : raw).trim() as ParamType
    if (!PARAM_TYPES.includes(type)) { problems.push(`${where}: param ${name} has unknown type "${raw}"`); return null }
    return { type, required: !optional }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    const type = r.type as ParamType
    if (!PARAM_TYPES.includes(type)) { problems.push(`${where}: param ${name} has unknown type "${String(r.type)}"`); return null }
    return { type, required: r.required !== false, ...(str(r.description) ? { description: str(r.description)! } : {}) }
  }
  problems.push(`${where}: param ${name} must be a type name or an object`)
  return null
}

function parseAction(raw: unknown, index: number, problems: string[]): ConnectorAction | null {
  const where = `actions[${index}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${where} must be an object`); return null }
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id || !ACTION_ID_RE.test(id)) problems.push(`${where}.id must match ${ACTION_ID_RE}`)
  const effect = r.effect
  if (effect !== 'read' && effect !== 'write') problems.push(`${where}.effect must be read or write`)
  const method = (str(r.method) ?? 'GET').toUpperCase() as HttpMethod
  if (!HTTP_METHODS.includes(method)) problems.push(`${where}.method must be one of ${HTTP_METHODS.join(', ')}`)
  if (effect === 'read' && HTTP_METHODS.includes(method) && !SAFE_METHODS.includes(method)) {
    problems.push(`${where}: a ${method} action cannot be marked read`)
  }
  const path = str(r.path)
  if (!path || !path.startsWith('/') || path.includes('..') || /[?#\s]/.test(path)) {
    problems.push(`${where}.path must start with / and contain no .., query, fragment or spaces`)
  }
  const params: Record<string, ParamSpec> = {}
  if (r.params !== undefined && r.params !== null) {
    if (typeof r.params !== 'object' || Array.isArray(r.params)) problems.push(`${where}.params must be a map`)
    else {
      const entries = Object.entries(r.params as Record<string, unknown>)
      if (entries.length > MAX_PARAMS) problems.push(`${where}: at most ${MAX_PARAMS} params`)
      for (const [name, spec] of entries) {
        if (!PARAM_NAME_RE.test(name)) { problems.push(`${where}: invalid param name ${name}`); continue }
        const parsed = parseParam(name, spec, where, problems)
        if (parsed) params[name] = parsed
      }
    }
  }
  for (const p of path ? pathParams(path) : []) {
    if (!params[p]) problems.push(`${where}: path segment {${p}} has no matching param`)
    else params[p] = { ...params[p], required: true }
  }
  if (!id || (effect !== 'read' && effect !== 'write') || !path || !HTTP_METHODS.includes(method)) return null
  return { id, effect, method, path, params, ...(str(r.description) ? { description: str(r.description)! } : {}) }
}

/** `auth: { type: header, name: X-API-Key, credential: market-data-key }`,
 *  `{ type: bearer, credential: … }` or `{ type: query, name: apikey, credential: … }`.
 *  Only the credential's name lives here; the value stays in the daemon's vault. */
function parseAuth(raw: unknown, problems: string[]): ConnectorAuth | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) { problems.push('auth must be a map'); return undefined }
  const a = raw as Record<string, unknown>
  const credential = str(a.credential)
  if (!credential || !CREDENTIAL_NAME_RE.test(credential)) {
    problems.push(`auth.credential must match ${CREDENTIAL_NAME_RE}`)
    return undefined
  }
  if (a.type === 'bearer') return { type: 'bearer', credential }
  const name = str(a.name)
  if (a.type === 'header') {
    if (!name || !HEADER_NAME_RE.test(name)) { problems.push('auth.name must be a header name'); return undefined }
    if (FORBIDDEN_AUTH_HEADERS.has(name.toLowerCase())) { problems.push(`auth.name ${name} cannot be used for a credential`); return undefined }
    return { type: 'header', name, credential }
  }
  if (a.type === 'query') {
    if (!name || !PARAM_NAME_RE.test(name)) { problems.push('auth.name must be a query parameter name'); return undefined }
    return { type: 'query', name, credential }
  }
  problems.push('auth.type must be header, bearer or query')
  return undefined
}

function checkBaseUrl(raw: string | null, opts: ParseOptions, problems: string[]): string | null {
  if (!raw) { problems.push('base_url is required'); return null }
  let url: URL
  try { url = new URL(raw) } catch { problems.push('base_url is not a valid URL'); return null }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(opts.allowLoopbackHttp && loopback && url.protocol === 'http:')) {
    problems.push('base_url must use https')
  }
  if (url.username || url.password) problems.push('base_url must not embed credentials')
  if (url.search || url.hash) problems.push('base_url must not have a query or fragment')
  return url.href.replace(/\/+$/, '')
}

export function parseConnectorYaml(source: string, opts: ParseOptions = {}): ConnectorDefinition {
  if (Buffer.byteLength(source) > MAX_CONNECTOR_YAML_BYTES) throw new ConnectorSchemaError([`definition exceeds ${MAX_CONNECTOR_YAML_BYTES} bytes`])
  let doc: unknown
  try {
    doc = yaml.load(source, { schema: yaml.JSON_SCHEMA })
  } catch (err) {
    throw new ConnectorSchemaError([`YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`])
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ConnectorSchemaError(['the definition must be a YAML map'])
  const r = doc as Record<string, unknown>
  const problems: string[] = []

  const slug = str(r.id)
  if (!slug || !SLUG_RE.test(slug)) problems.push(`id must match ${SLUG_RE}`)
  const kind = str(r.kind) ?? 'http'
  if (kind !== 'http') problems.push(`kind ${kind} is not supported yet (only http)`)
  const auth = parseAuth(r.auth, problems)
  const baseUrl = checkBaseUrl(str(r.base_url), opts, problems)

  let rateLimitPerMinute = DEFAULT_RATE_LIMIT_PER_MINUTE
  if (r.rate_limit !== undefined) {
    const per = (r.rate_limit as { per_minute?: unknown } | null)?.per_minute
    if (typeof per !== 'number' || !Number.isInteger(per) || per < 1 || per > 6000) problems.push('rate_limit.per_minute must be an integer from 1 to 6000')
    else rateLimitPerMinute = per
  }

  const actions: ConnectorAction[] = []
  if (!Array.isArray(r.actions) || r.actions.length === 0) problems.push('actions must be a non-empty list')
  else if (r.actions.length > MAX_ACTIONS) problems.push(`at most ${MAX_ACTIONS} actions`)
  else {
    const seen = new Set<string>()
    r.actions.forEach((a, i) => {
      const action = parseAction(a, i, problems)
      if (!action) return
      if (seen.has(action.id)) problems.push(`duplicate action id ${action.id}`)
      seen.add(action.id)
      actions.push(action)
    })
  }

  if (auth?.type === 'query') {
    const clash = actions.find((a) => a.params[auth.name])
    if (clash) problems.push(`auth query parameter ${auth.name} is also a param of action ${clash.id}`)
  }

  if (problems.length) throw new ConnectorSchemaError(problems)
  return {
    slug: slug!, kind: 'http', baseUrl: baseUrl!, rateLimitPerMinute, actions,
    ...(auth ? { auth } : {}),
    ...(str(r.name) ? { name: str(r.name)! } : {}),
    ...(str(r.description) ? { description: str(r.description)! } : {}),
  }
}
