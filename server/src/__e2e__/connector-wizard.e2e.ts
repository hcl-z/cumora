/**
 * Connector onboarding end to end (task T10): import an OpenAPI document by
 * URL, review the read/write marking, set the API key, and try a read action
 * from the console. The test call runs on the real daemon (it holds the
 * key), so this checks that the API got the key, the console got at most
 * 2KB, and the key came back redacted.
 *
 * Needs Postgres and Redis (see stack.ts); skipped without them unless
 * E2E_REQUIRED=1.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { sealCredential } from '../broker/vault.js'
import { FakeHttp } from './fake-http.js'
import { type Stack, eventually, stackUnavailableReason, startStack } from './stack.js'

const SECRET = 'sk-e2e-wizard-4c19a7d2b0e8'

interface Action { id: string; effect: string; effectConfirmed: boolean }
interface Connector { id: string; slug: string; status: string; actions: Action[] }
interface TestResult { status: number; bytes: number; preview: string; truncated: boolean }

const unavailable = await stackUnavailableReason()
if (unavailable && process.env.E2E_REQUIRED === '1') throw new Error(`e2e stack unavailable: ${unavailable}`)

let stack: Stack | null = null
const api = new FakeHttp([
  {
    method: 'GET',
    path: '/openapi.json',
    respond: () => ({
      status: 200,
      body: {
        openapi: '3.0.3',
        info: { title: 'Wizard Data' },
        servers: [{ url: '/v1' }],
        components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
        paths: {
          '/report/{id}': { get: { operationId: 'getReport', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
          '/orders': { post: { operationId: 'placeOrder', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } },
        },
      },
    }),
  },
  {
    method: 'GET',
    path: '/v1/report/R1',
    // A long report that also (badly) echoes the key.
    respond: (req) => req.headers['x-api-key'] === SECRET
      ? { status: 200, body: { id: 'R1', echoedKey: req.headers['x-api-key'], rows: Array.from({ length: 400 }, (_, i) => ({ i, v: 'x'.repeat(20) })) } }
      : { status: 401, body: { error: 'missing or wrong key' } },
  },
])

before(async () => {
  if (unavailable) return
  await api.start()
  stack = await startStack({ cassette: { version: 1, interactions: [] } })
})

after(async () => {
  if (stack) {
    if (process.env.E2E_LOG_DIR) await stack.dumpLogs(join(process.env.E2E_LOG_DIR, 'connector-wizard.log'))
    await stack.stop()
  }
  await api.stop()
})

test('import from OpenAPI, mark reads, set the key, try a read action', { skip: unavailable ?? false, timeout: 180_000 }, async () => {
  const s = stack!
  await s.daemon.waitFor(/\[computer\] paired as /, 60_000)

  // Step 1: import by URL. Both operations start as unconfirmed writes.
  const created = await s.api<{ connector: Connector; warnings: string[] }>('/personal/connectors', {
    method: 'POST', body: { openapi: { url: `${api.baseUrl}/openapi.json` } },
  })
  const c = created.connector
  assert.equal(c.slug, 'wizard-data')
  assert.deepEqual(c.actions.map((a) => [a.id, a.effect, a.effectConfirmed]), [['get_report', 'write', false], ['place_order', 'write', false]])

  // Step 2: GET becomes read; POST cannot; confirm the rest.
  await assert.rejects(s.api(`/personal/connectors/${c.id}/actions/place_order`, { method: 'PATCH', body: { effect: 'read' } }), /400/)
  await s.api(`/personal/connectors/${c.id}/actions/get_report`, { method: 'PATCH', body: { effect: 'read' } })
  await s.api(`/personal/connectors/${c.id}/actions/confirm`, { method: 'POST' })

  // Step 3: the key, sealed the browser's way, then a test call on the draft.
  const key = await eventually(async () => {
    const k = await s.api<{ computerId: string; online: boolean; publicKey: Record<string, string> }>('/personal/vault-key').catch(() => null)
    return k?.online ? k : null
  }, 60_000, 'the vault key')
  const sealed = sealCredential(key.publicKey, { connector: 'wizard-data', name: 'wizard-data-key', value: SECRET })
  await eventually(
    () => s.api(`/personal/connectors/${c.id}/credentials`, { method: 'POST', body: { name: 'wizard-data-key', computerId: key.computerId, sealed } }),
    30_000, 'the credential to be stored',
  )
  const { result } = await s.api<{ result: TestResult }>(`/personal/connectors/${c.id}/test`, {
    method: 'POST', body: { action: 'get_report', args: { id: 'R1' } },
  })
  assert.equal(result.status, 200)
  assert.equal(result.truncated, true)
  assert.ok(result.bytes > 2048)
  assert.ok(Buffer.byteLength(result.preview) <= 2048)
  assert.match(result.preview, /\[REDACTED:wizard-data-key\]/)
  assert.ok(!result.preview.includes(SECRET))

  const reportCalls = api.requests.filter((r) => r.path === '/v1/report/R1')
  assert.equal(reportCalls.length, 1)
  assert.equal(reportCalls[0].headers['x-api-key'], SECRET, 'the API got the real key')
  assert.ok(!s.server.lines.join('\n').includes(SECRET), 'the server never saw the key')

  // Writes cannot be tried, and only now can it be enabled.
  await assert.rejects(s.api(`/personal/connectors/${c.id}/test`, { method: 'POST', body: { action: 'place_order', args: {} } }), /400/)
  const enabled = await s.api<{ connector: Connector }>(`/personal/connectors/${c.id}`, { method: 'PATCH', body: { status: 'active' } })
  assert.equal(enabled.connector.status, 'active')
})
