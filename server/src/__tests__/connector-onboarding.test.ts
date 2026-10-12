/**
 * Connector onboarding (task T10): OpenAPI documents become connector YAML
 * with every action write, and the console test call runs one read action
 * on the bot host and returns the first 2KB, redacted.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runConnectorTest } from '../broker/broker.js'
import { type ConnectorAction, type ConnectorDefinition, TEST_PREVIEW_BYTES } from '../broker/definition.js'
import type { HttpResult } from '../broker/http-executor.js'
import { parseComputerControlEvent } from '../agents/computer/control-event.js'
import { ConnectorSchemaError, parseConnectorYaml } from '../personal/connector-schema.js'
import { openApiToConnectorYaml } from '../personal/openapi-import.js'

const DOC = {
  openapi: '3.1.0',
  info: { title: 'Market Data API', description: 'Quotes and orders' },
  servers: [{ url: 'https://{region}.example.com/v1', variables: { region: { default: 'eu' } } }],
  components: {
    securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
    schemas: { Order: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, qty: { type: 'integer' }, meta: { type: 'object' } } } },
  },
  paths: {
    '/quote/{symbol}': {
      parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getQuote', summary: 'Latest quote', parameters: [{ $ref: '#/components/parameters/Limit' }, { name: 'X-Trace', in: 'header', schema: { type: 'string' } }] },
    },
    '/orders': {
      get: { summary: 'List orders' },
      post: { operationId: 'placeOrder', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
    },
    '/bulk': { post: { operationId: 'bulk', requestBody: { required: true, content: { 'application/json': { schema: { type: 'array', items: {} } } } } } },
    '/search': { get: { operationId: 'search', parameters: [{ name: 'tags', in: 'query', required: true, schema: { type: 'array' } }] } },
  },
}

test('an OpenAPI document becomes a valid connector with every action write', () => {
  const out = openApiToConnectorYaml(JSON.stringify(DOC))
  const def = parseConnectorYaml(out.yaml)
  assert.equal(out.slug, 'market-data-api')
  assert.equal(def.baseUrl, 'https://eu.example.com/v1')
  assert.deepEqual(def.auth, { type: 'header', name: 'X-API-Key', credential: 'market-data-api-key' })
  const byId = Object.fromEntries(def.actions.map((a) => [a.id, a]))
  assert.deepEqual(Object.keys(byId).sort(), ['get_orders', 'get_quote', 'place_order'])
  assert.ok(def.actions.every((a) => a.effect === 'write'), 'an import never decides an action is a read')
  assert.deepEqual(byId.get_quote.params, { symbol: { type: 'string', required: true }, limit: { type: 'integer', required: false } })
  assert.equal(byId.get_quote.description, 'Latest quote')
  assert.deepEqual(byId.place_order.params, { symbol: { type: 'string', required: true }, qty: { type: 'integer', required: false } })
  assert.equal(byId.place_order.method, 'POST')
  // Skipped and simplified operations are reported, not half-imported.
  assert.ok(out.warnings.some((w) => /POST \/bulk: skipped/.test(w)))
  assert.ok(out.warnings.some((w) => /GET \/search: skipped, parameter tags is not a scalar/.test(w)))
  assert.ok(out.warnings.some((w) => /dropped optional body field meta/.test(w)))
})

test('a YAML OpenAPI document, a relative server and a chosen id', () => {
  const yamlDoc = [
    'openapi: 3.0.0',
    'info: { title: Thing }',
    'servers: [{ url: /api }]',
    'components: { securitySchemes: { b: { type: http, scheme: bearer } } }',
    'paths:',
    '  /items/{id}: { get: { parameters: [{ name: id, in: path, required: true, schema: { type: integer } }] } }',
  ].join('\n')
  const out = openApiToConnectorYaml(yamlDoc, { slug: 'things', sourceUrl: 'https://svc.example.org/docs/openapi.yaml' })
  const def = parseConnectorYaml(out.yaml)
  assert.equal(def.slug, 'things')
  assert.equal(def.baseUrl, 'https://svc.example.org/api')
  assert.deepEqual(def.auth, { type: 'bearer', credential: 'things-key' })
  assert.deepEqual(def.actions.map((a) => [a.id, a.path, a.params.id?.type]), [['get_items_by_id', '/items/{id}', 'integer']])
})

test('documents that cannot become a connector are refused with a reason', () => {
  const refuse = (source: string, pattern: RegExp, opts = {}) => assert.throws(
    () => openApiToConnectorYaml(source, opts),
    (err: unknown) => err instanceof ConnectorSchemaError && pattern.test(err.message),
  )
  refuse('{"swagger":"2.0"}', /Swagger 2\.0 is not supported/)
  refuse('{"openapi":"3.0.0","paths":{}}', /no servers\[0\]\.url/)
  refuse(JSON.stringify({ ...DOC, paths: {} }), /no operation in the document could be imported/)
  refuse('not: [valid', /not JSON or YAML/)
  refuse(JSON.stringify(DOC), /must match/, { slug: 'Bad Slug' })
  // http servers go through the same https rule as hand-written YAML.
  const http = openApiToConnectorYaml(JSON.stringify({ ...DOC, servers: [{ url: 'http://api.example.com' }] }))
  assert.throws(() => parseConnectorYaml(http.yaml), /must use https/)
})

// ── the console test call ─────────────────────────────────────────────────

const quote: ConnectorAction = { id: 'quote', effect: 'read', method: 'GET', path: '/quote/{symbol}', params: { symbol: { type: 'string', required: true } } }
const order: ConnectorAction = { id: 'order', effect: 'write', method: 'POST', path: '/orders', params: {} }
const DEF: ConnectorDefinition = {
  slug: 'md', kind: 'http', baseUrl: 'https://api.example.com', rateLimitPerMinute: 60,
  auth: { type: 'header', name: 'X-API-Key', credential: 'md-key' }, actions: [quote, order],
}

function fakeExecute(body: string, calls: Array<{ action: string; credential: string | null | undefined }>) {
  return async (_def: ConnectorDefinition, action: ConnectorAction, _args: Record<string, unknown>, opts: { credential?: string | null }): Promise<HttpResult> => {
    calls.push({ action: action.id, credential: opts.credential })
    return { status: 200, contentType: 'application/json', body: Buffer.from(body), durationMs: 7 }
  }
}

test('a test call returns the first 2KB of the response with the credential redacted', async () => {
  const calls: Array<{ action: string; credential: string | null | undefined }> = []
  const body = JSON.stringify({ echoed: 'sk-secret-123', padding: '界'.repeat(2000) })
  const out = await runConnectorTest(DEF, 'quote', { symbol: 'ACME' }, {
    credential: () => 'sk-secret-123',
    redact: (t) => t.replaceAll('sk-secret-123', '[REDACTED:md-key]'),
    execute: fakeExecute(body, calls),
  })
  assert.equal(out.ok, true)
  if (!out.ok) return
  assert.deepEqual(calls, [{ action: 'quote', credential: 'sk-secret-123' }])
  assert.equal(out.result.status, 200)
  assert.equal(out.result.bytes, Buffer.byteLength(body))
  assert.equal(out.result.truncated, true)
  assert.ok(Buffer.byteLength(out.result.preview) <= TEST_PREVIEW_BYTES)
  assert.ok(!out.result.preview.includes('\uFFFD'), 'never cuts a character in half')
  assert.match(out.result.preview, /\[REDACTED:md-key\]/)
  assert.ok(!out.result.preview.includes('sk-secret-123'))
})

test('a test call refuses writes, bad args and a missing credential without calling out', async () => {
  const calls: Array<{ action: string; credential: string | null | undefined }> = []
  const deps = { credential: () => null, execute: fakeExecute('{}', calls) }
  const write = await runConnectorTest(DEF, 'order', {}, { ...deps, credential: () => 'k' })
  assert.deepEqual(write, { ok: false, error: 'only read actions can be tried' })
  // The definition came over the control stream; a "read" POST is refused too.
  const forged = await runConnectorTest({ ...DEF, actions: [{ ...order, effect: 'read' }] }, 'order', {}, { ...deps, credential: () => 'k' })
  assert.equal(forged.ok, false)
  assert.match((await runConnectorTest(DEF, 'quote', {}, { ...deps, credential: () => 'k' }) as { error: string }).error, /missing required param: symbol/)
  assert.match((await runConnectorTest(DEF, 'quote', { symbol: 'A' }, deps) as { error: string }).error, /md-key is not set on the bot host/)
  assert.match((await runConnectorTest(DEF, 'nope', {}, deps) as { error: string }).error, /no action nope/)
  assert.deepEqual(calls, [])
})

test('a failed test call reports the reason, redacted', async () => {
  const out = await runConnectorTest(DEF, 'quote', { symbol: 'A' }, {
    credential: () => 'sk-secret-123',
    redact: (t) => t.replaceAll('sk-secret-123', '[REDACTED:md-key]'),
    execute: async () => { throw new Error('connect refused for sk-secret-123') },
  })
  assert.deepEqual(out, { ok: false, error: 'connect refused for [REDACTED:md-key]' })
})

test('connector.test control events are parsed only when complete', () => {
  const event = { kind: 'connector.test', id: 'connector.test-1', at: Date.now(), requestId: 'r1', definition: DEF, action: 'quote', args: { symbol: 'A' } }
  assert.deepEqual(parseComputerControlEvent(JSON.stringify(event)), event)
  for (const broken of [
    { ...event, requestId: '' },
    { ...event, args: [] },
    { ...event, action: undefined },
    { ...event, definition: { slug: 'md' } },
  ]) assert.equal(parseComputerControlEvent(JSON.stringify(broken)), null)
})
