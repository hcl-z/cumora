/**
 * Connector tracer bullet (task T08, product plan A4 minimal + B2): the owner
 * adds an HTTP connector from YAML, enables it for ad-hoc reads, and asks
 * Chief in 总群. Chief's write attempt is denied and audited server-side; its
 * read goes through the daemon's Broker to a fixture service, comes back as
 * evidence ev_1, and the answer cites it. The audit trail holds both events.
 *
 * Needs Postgres and Redis (see stack.ts); skipped without them unless
 * E2E_REQUIRED=1.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'
import { FakeHttp } from './fake-http.js'
import { loadCassette } from './fake-openai.js'
import { E2E_DATABASE_URL, type Stack, eventually, stackUnavailableReason, startStack } from './stack.js'

interface Conversation { id: string; title: string | null }
interface Message { id: string; authorId: string; body: string }

const unavailable = await stackUnavailableReason()
if (unavailable && process.env.E2E_REQUIRED === '1') throw new Error(`e2e stack unavailable: ${unavailable}`)

let stack: Stack | null = null
const quotes = new FakeHttp([{ method: 'GET', path: '/quote/ACME', body: { symbol: 'ACME', price: 42.5, currency: 'USD' } }])

before(async () => {
  if (unavailable) return
  await quotes.start()
  stack = await startStack({ cassette: await loadCassette(join(import.meta.dirname, 'cassettes', 'connector-quote.json')) })
})

after(async () => {
  if (stack) {
    if (process.env.E2E_LOG_DIR) await stack.dumpLogs(join(process.env.E2E_LOG_DIR, 'connector.log'))
    await stack.stop()
  }
  await quotes.stop()
})

test('Chief answers from a connector read, and the denied write is audited', { skip: unavailable ?? false, timeout: 180_000 }, async () => {
  const s = stack!
  const yaml = [
    'id: market-data',
    'name: Market data',
    `base_url: ${quotes.baseUrl}`,
    'actions:',
    '  - id: quote',
    '    effect: read',
    '    method: GET',
    '    path: /quote/{symbol}',
    '    params: { symbol: string }',
    '  - id: place_order',
    '    effect: write',
    '    method: POST',
    '    path: /orders',
    '    params: { symbol: string, qty: integer }',
  ].join('\n')
  const { connector } = await s.api<{ connector: { id: string; status: string } }>('/personal/connectors', {
    method: 'POST', body: { yaml, adhocRead: true },
  })
  assert.equal(connector.status, 'draft')
  await s.api(`/personal/connectors/${connector.id}`, { method: 'PATCH', body: { status: 'active' } })

  const general = await eventually(async () => {
    const convos = await s.api<Conversation[]>('/conversations')
    return convos.find((c) => c.title === '总群') ?? null
  }, 30_000, '总群 to exist')
  await s.daemon.waitFor(/\[computer\] paired as /, 60_000)

  await s.api(`/conversations/${general.id}/messages`, { method: 'POST', body: { body: '@Chief E2E-QUOTE ACME 现在多少钱？' } })

  const reply = await eventually(async () => {
    const msgs = await s.api<Message[]>(`/conversations/${general.id}/messages`)
    return msgs.find((m) => m.body.includes('E2E-QUOTE-ANSWER')) ?? null
  }, 120_000, "Chief's answer")
  assert.match(reply.authorId, /^chief-/)
  assert.equal(reply.body, 'E2E-QUOTE-ANSWER ACME 现价 42.5 [ev_1]')

  // The fixture saw exactly the read; the denied write never left the daemon.
  assert.deepEqual(quotes.requests.map((r) => [r.method, r.path]), [['GET', '/quote/ACME']])
  assert.deepEqual(s.openai.unmatched.filter((r) => r.kind === 'agent'), [])
  assert.equal(s.openai.unusedInteractions().length, 0)

  const db = new pg.Client({ connectionString: E2E_DATABASE_URL })
  await db.connect()
  try {
    const events = await eventually(async () => {
      const { rows } = await db.query<{ kind: string; data: Record<string, unknown> }>(
        `SELECT kind, data FROM agent_events WHERE kind IN ('connector.denied', 'connector.call') ORDER BY created_at`,
      )
      return rows.length >= 2 ? rows : null
    }, 30_000, 'connector audit events')
    const denied = events.find((e) => e.kind === 'connector.denied')
    const called = events.find((e) => e.kind === 'connector.call')
    assert.ok(denied, 'the denial is audited')
    assert.equal(denied.data.action, 'market-data.place_order')
    assert.match(String(denied.data.reason), /write actions need an approval/)
    assert.ok(called, 'the read is audited')
    assert.equal(called.data.action, 'market-data.quote')
    assert.equal(called.data.status, 200)
    assert.equal(called.data.evidenceId, 'ev_1')
  } finally {
    await db.end()
  }
})
