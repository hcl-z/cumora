/**
 * Turn an OpenAPI 3 document into connector YAML (task T10; frontend design
 * §3.2 step 1). The result goes through parseConnectorYaml like any other
 * definition, so nothing here is trusted on its own.
 *
 * Every generated action is `effect: write`: an import never decides that an
 * operation is harmless. The user downgrades GET/HEAD operations to read in
 * the wizard's second step; other methods cannot be downgraded at all.
 *
 * Only what a connector can express is imported: scalar path/query params
 * and the scalar top-level properties of a JSON request body. Anything else
 * is skipped with a warning rather than half-supported.
 */
import yaml from 'js-yaml'
import {
  ACTION_ID_RE, CREDENTIAL_NAME_RE, FORBIDDEN_AUTH_HEADERS, HEADER_NAME_RE, HTTP_METHODS, type HttpMethod, PARAM_NAME_RE, type ParamType, SLUG_RE,
} from '../broker/definition.js'
import { ConnectorSchemaError, MAX_CONNECTOR_YAML_BYTES } from './connector-schema.js'

export const MAX_OPENAPI_BYTES = 1024 * 1024
const MAX_ACTIONS = 64
const MAX_WARNINGS = 30

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export interface OpenApiImport {
  yaml: string
  slug: string
  warnings: string[]
}

interface Param { name: string; type: ParamType; required: boolean; description?: string }

function slugify(raw: string, max: number, sep: '-' | '_'): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, `$1${sep}$2`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^[${sep}0-9]+|[${sep}]+$`, 'g'), '')
    .slice(0, max)
    .replace(new RegExp(`[${sep}]+$`), '')
}

/** Follow a local `#/components/...` reference, a few levels deep. */
function deref(doc: Obj, value: unknown, depth = 0): unknown {
  if (!isObj(value) || typeof value.$ref !== 'string') return value
  if (depth > 8 || !value.$ref.startsWith('#/')) return undefined
  let cur: unknown = doc
  for (const part of value.$ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    cur = isObj(cur) ? cur[key] : undefined
  }
  return deref(doc, cur, depth + 1)
}

function scalarType(schema: unknown): ParamType | null {
  if (!isObj(schema)) return 'string'
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type
  if (t === undefined) return isObj(schema.properties) || schema.items ? null : 'string'
  return t === 'string' || t === 'integer' || t === 'number' || t === 'boolean' ? t : null
}

function shortDescription(...candidates: unknown[]): string | undefined {
  const d = candidates.map(text).find(Boolean)
  return d ? d.replace(/\s+/g, ' ').slice(0, 200) : undefined
}

function resolveBaseUrl(doc: Obj, sourceUrl: string | undefined, warnings: string[]): string | null {
  const servers = Array.isArray(doc.servers) ? doc.servers.filter(isObj) : []
  const server = servers[0]
  let raw = server ? text(server.url) : null
  if (!raw) return sourceUrl ? new URL('/', sourceUrl).href : null
  if (server && isObj(server.variables)) {
    for (const [name, v] of Object.entries(server.variables)) {
      const fallback = isObj(v) && typeof v.default === 'string' ? v.default : ''
      raw = raw.replaceAll(`{${name}}`, fallback)
    }
  }
  if (servers.length > 1) warnings.push(`the document lists ${servers.length} servers; using the first (${raw})`)
  try {
    return new URL(raw, sourceUrl).href
  } catch {
    warnings.push(`servers[0].url "${raw}" is not an absolute URL; set base_url yourself`)
    return null
  }
}

function importAuth(doc: Obj, slug: string, warnings: string[]): Obj | undefined {
  const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : null
  if (!schemes) return undefined
  const credential = `${slug}-key`.slice(0, 64)
  if (!CREDENTIAL_NAME_RE.test(credential)) return undefined
  for (const [id, rawScheme] of Object.entries(schemes)) {
    const s = deref(doc, rawScheme)
    if (!isObj(s)) continue
    if (s.type === 'http' && String(s.scheme).toLowerCase() === 'bearer') return { type: 'bearer', credential }
    if (s.type === 'apiKey' && typeof s.name === 'string') {
      if (s.in === 'header' && HEADER_NAME_RE.test(s.name) && !FORBIDDEN_AUTH_HEADERS.has(s.name.toLowerCase())) {
        return { type: 'header', name: s.name, credential }
      }
      if (s.in === 'query' && PARAM_NAME_RE.test(s.name)) return { type: 'query', name: s.name, credential }
    }
    warnings.push(`security scheme ${id} (${String(s.type)}) is not supported; add auth by hand if the API needs it`)
  }
  return undefined
}

function operationParams(doc: Obj, pathItem: Obj, op: Obj, method: HttpMethod, where: string, warnings: string[]): Param[] | null {
  const merged = new Map<string, Obj>()
  for (const list of [pathItem.parameters, op.parameters]) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const p = deref(doc, raw)
      if (isObj(p) && typeof p.name === 'string' && typeof p.in === 'string') merged.set(`${p.in}:${p.name}`, p)
    }
  }
  const params: Param[] = []
  for (const p of merged.values()) {
    if (p.in === 'header' || p.in === 'cookie') continue
    const name = p.name as string
    if (!PARAM_NAME_RE.test(name)) { warnings.push(`${where}: skipped, parameter "${name}" has an unsupported name`); return null }
    const type = scalarType(deref(doc, p.schema))
    if (!type) {
      if (p.required === true || p.in === 'path') { warnings.push(`${where}: skipped, parameter ${name} is not a scalar`); return null }
      warnings.push(`${where}: dropped optional parameter ${name} (not a scalar)`)
      continue
    }
    params.push({ name, type, required: p.in === 'path' || p.required === true, description: shortDescription(p.description) })
  }
  const hasQuery = [...merged.values()].some((p) => p.in === 'query')
  const body = deref(doc, op.requestBody)
  if (isObj(body)) {
    const content = isObj(body.content) ? body.content : {}
    const json = Object.entries(content).find(([type]) => /json/i.test(type))?.[1]
    const schema = isObj(json) ? deref(doc, json.schema) : undefined
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
      warnings.push(`${where}: ignored the request body (a ${method} call sends params in the query string)`)
    } else if (hasQuery) {
      warnings.push(`${where}: skipped, it mixes query parameters with a body`)
      return null
    } else if (!isObj(schema) || !isObj(schema.properties)) {
      if (body.required === true) { warnings.push(`${where}: skipped, the request body is not a JSON object with properties`); return null }
    } else {
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === 'string') : [])
      for (const [name, rawProp] of Object.entries(schema.properties)) {
        const prop = deref(doc, rawProp)
        const type = scalarType(prop)
        if (!type || !PARAM_NAME_RE.test(name)) {
          if (required.has(name)) { warnings.push(`${where}: skipped, body field ${name} is not a scalar`); return null }
          warnings.push(`${where}: dropped optional body field ${name}`)
          continue
        }
        if (params.some((p) => p.name === name)) { warnings.push(`${where}: skipped, body field ${name} clashes with a parameter`); return null }
        params.push({ name, type, required: required.has(name), description: shortDescription(isObj(prop) ? prop.description : undefined) })
      }
    }
  }
  return params
}

/** Parse the document (JSON or YAML) and build a connector definition.
 *  Throws ConnectorSchemaError when nothing usable is in it. */
export function openApiToConnectorYaml(source: string, opts: { slug?: string; sourceUrl?: string } = {}): OpenApiImport {
  if (Buffer.byteLength(source) > MAX_OPENAPI_BYTES) throw new ConnectorSchemaError([`the OpenAPI document exceeds ${MAX_OPENAPI_BYTES} bytes`])
  let doc: unknown
  try {
    doc = yaml.load(source, { schema: yaml.JSON_SCHEMA })
  } catch (err) {
    throw new ConnectorSchemaError([`not JSON or YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`])
  }
  if (!isObj(doc)) throw new ConnectorSchemaError(['the OpenAPI document must be an object'])
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new ConnectorSchemaError([doc.swagger ? 'Swagger 2.0 is not supported; convert it to OpenAPI 3 first' : 'not an OpenAPI 3 document (no "openapi: 3.x")'])
  }
  const info = isObj(doc.info) ? doc.info : {}
  const warnings: string[] = []
  const slug = opts.slug ?? (slugify(text(info.title) ?? '', 48, '-') || 'imported-api')
  if (!SLUG_RE.test(slug)) throw new ConnectorSchemaError([`connector id "${slug}" must match ${SLUG_RE}`])

  const baseUrl = resolveBaseUrl(doc, opts.sourceUrl, warnings)
  if (!baseUrl) throw new ConnectorSchemaError(['the document has no servers[0].url; import it from its URL or add base_url by hand'])
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '')
  const auth = importAuth(doc, slug, warnings)

  const actions: Obj[] = []
  const used = new Set<string>()
  let skipped = 0
  for (const [path, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const pathItem = deref(doc, rawItem)
    if (!isObj(pathItem)) continue
    for (const lower of ['get', 'head', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[lower]
      if (!isObj(op)) continue
      const method = lower.toUpperCase() as HttpMethod
      const where = `${method} ${path}`
      if (!HTTP_METHODS.includes(method)) continue
      if (!path.startsWith('/') || path.includes('..') || /[?#\s]/.test(path)) { warnings.push(`${where}: skipped, unsupported path`); skipped++; continue }
      const params = operationParams(doc, pathItem, op, method, where, warnings)
      if (!params) { skipped++; continue }
      if (actions.length >= MAX_ACTIONS) { skipped++; continue }
      let id = slugify(text(op.operationId) ?? `${lower} ${path.replace(/\{([^}]*)\}/g, ' by $1 ')}`, 40, '_') || lower
      if (!/^[a-z]/.test(id)) id = `op_${id}`.slice(0, 40)
      const stem = id
      for (let n = 2; used.has(id); n++) id = `${stem}_${n}`
      if (!ACTION_ID_RE.test(id)) { warnings.push(`${where}: skipped, could not derive an action id`); skipped++; continue }
      used.add(id)
      const paramMap: Obj = {}
      for (const p of params) {
        paramMap[p.name] = p.description ? { type: p.type, required: p.required, description: p.description } : `${p.type}${p.required ? '' : '?'}`
      }
      actions.push({
        id,
        effect: 'write',
        method,
        // servers[0].url already carries the base path; the paths here are relative to it.
        path: basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path,
        ...(params.length ? { params: paramMap } : {}),
        ...(shortDescription(op.summary, op.description) ? { description: shortDescription(op.summary, op.description) } : {}),
      })
    }
  }
  if (actions.length >= MAX_ACTIONS && skipped) warnings.push(`kept the first ${MAX_ACTIONS} operations; a connector holds at most ${MAX_ACTIONS}`)
  if (!actions.length) throw new ConnectorSchemaError(['no operation in the document could be imported', ...warnings.slice(0, 10)])

  const def: Obj = {
    id: slug,
    ...(text(info.title) ? { name: text(info.title)!.slice(0, 80) } : {}),
    ...(shortDescription(info.description) ? { description: shortDescription(info.description) } : {}),
    base_url: baseUrl.replace(/\/+$/, ''),
    ...(auth ? { auth } : {}),
    actions,
  }
  const out = yaml.dump(def, { lineWidth: 120, noRefs: true, quotingType: '"' })
  if (Buffer.byteLength(out) > MAX_CONNECTOR_YAML_BYTES) throw new ConnectorSchemaError(['the imported definition is too large; import a smaller document'])
  return { yaml: out, slug, warnings: warnings.slice(0, MAX_WARNINGS) }
}
