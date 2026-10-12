/**
 * Connector onboarding against a real Postgres (task T10): OpenAPI import,
 * the per-action read/write marking (and the 400 for downgrading a
 * non-GET/HEAD action), the enable gate on unconfirmed markings, a bot's
 * `cumora connector draft`, and the console test call's refusals.
 *
 * Run: INTEGRATION_DATABASE_URL=… npm run test:integration
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { runCli } from '../agents/cli.js'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { authorizeConnectorCall } from '../personal/connectors.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'

const COMPANY = 'co-connector-review'
const OWNER = 'u-review-owner'
const BOT = 'chief-review'

const OPENAPI = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Market Data', version: '1' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/quote/{symbol}': {
      get: { operationId: 'getQuote', summary: 'Latest quote', parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }] },
    },
    '/orders': {
      post: {
        operationId: 'placeOrder',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, qty: { type: 'integer' } } } } } },
      },
    },
  },
})

let server: Server
let base: string
const personalModeBefore = env.PERSONAL_MODE

type Action = { id: string; effect: string; effectConfirmed: boolean; method: string }
type Connector = { id: string; slug: string; status: string; createdByKind: string; actions: Action[]; definitionYaml: string }

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-company-id': COMPANY },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const action = (c: Connector, id: string) => c.actions.find((a) => a.id === id)!

before(async () => {
  await ensureSchemaOnce()
  ;(env as { PERSONAL_MODE: boolean }).PERSONAL_MODE = true
  const app = await buildApiTestApp(OWNER)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((done) => server.once('listening', () => done()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
beforeEach(async () => {
  await resetAllTables()
  await pool.query(`INSERT INTO companies (id, name, slug) VALUES ($1, 'Review', 'review-ws')`, [COMPANY])
  await seedUserMembership(OWNER, COMPANY)
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1, $2, 'agent', 'Chief', 'chief', 'C', '#abcdef', 'avail')`,
    [BOT, COMPANY],
  )
})
after(async () => {
  ;(env as { PERSONAL_MODE: boolean }).PERSONAL_MODE = personalModeBefore
  await teardownAll(server)
})

test('[integration] an OpenAPI import lands as write actions that must be reviewed before enabling', async () => {
  const created = await call('POST', '/personal/connectors', { openapi: { spec: OPENAPI }, adhocRead: true })
  assert.equal(created.status, 201)
  const c = created.json.connector as Connector
  assert.equal(c.slug, 'market-data')
  assert.deepEqual(c.actions.map((a) => [a.id, a.effect, a.effectConfirmed, a.method]), [
    ['get_quote', 'write', false, 'GET'],
    ['place_order', 'write', false, 'POST'],
  ])
  assert.ok(Array.isArray(created.json.warnings))

  // Not enabled while a marking is unconfirmed.
  const early = await call('PATCH', `/personal/connectors/${c.id}`, { status: 'active' })
  assert.equal(early.status, 400)
  assert.match(String(early.json.error), /confirm the read\/write marking.*get_quote, place_order/)

  // POST cannot become read: 400, and nothing changed.
  const refused = await call('PATCH', `/personal/connectors/${c.id}/actions/place_order`, { effect: 'read' })
  assert.equal(refused.status, 400)
  assert.match(String(refused.json.error), /POST action .* cannot be marked read/)
  assert.equal(action((await call('GET', `/personal/connectors/${c.id}`)).json.connector as Connector, 'place_order').effect, 'write')

  // GET can; the stored YAML, the parsed definition and the row all agree.
  const read = (await call('PATCH', `/personal/connectors/${c.id}/actions/get_quote`, { effect: 'read' })).json.connector as Connector
  assert.deepEqual([action(read, 'get_quote').effect, action(read, 'get_quote').effectConfirmed], ['read', true])
  assert.match(read.definitionYaml, /id: get_quote\n\s+effect: read/)
  const def = await pool.query<{ e: string }>(`SELECT definition->'actions'->0->>'effect' AS e FROM connectors WHERE id = $1`, [c.id])
  assert.equal(def.rows[0].e, 'read')

  // Still one unconfirmed (the POST); confirm accepts it as write.
  assert.equal((await call('PATCH', `/personal/connectors/${c.id}`, { status: 'active' })).status, 400)
  const confirmed = (await call('POST', `/personal/connectors/${c.id}/actions/confirm`)).json.connector as Connector
  assert.ok(confirmed.actions.every((a) => a.effectConfirmed))
  assert.equal(((await call('PATCH', `/personal/connectors/${c.id}`, { status: 'active' })).json.connector as Connector).status, 'active')
  assert.equal((await authorizeConnectorCall({ companyId: COMPANY, action: 'market-data.get_quote' })).decision, 'allow')
  assert.equal((await authorizeConnectorCall({ companyId: COMPANY, action: 'market-data.place_order' })).decision, 'deny')
})

test('[integration] YAML the user wrote counts as confirmed; bad marking requests are refused', async () => {
  const yaml = 'id: hand-made\nbase_url: https://api.example.com\nactions:\n  - { id: quote, effect: read, method: GET, path: /q }\n'
  const c = (await call('POST', '/personal/connectors', { yaml })).json.connector as Connector
  assert.equal(action(c, 'quote').effectConfirmed, true)
  assert.equal((await call('PATCH', `/personal/connectors/${c.id}`, { status: 'active' })).status, 200)
  assert.equal((await call('PATCH', `/personal/connectors/${c.id}/actions/quote`, { effect: 'maybe' })).status, 400)
  assert.equal((await call('PATCH', `/personal/connectors/${c.id}/actions/nope`, { effect: 'read' })).status, 404)
  assert.equal((await call('POST', '/personal/connectors/con_missing/actions/confirm')).status, 404)
  assert.equal((await call('POST', '/personal/connectors', { yaml, openapi: { spec: OPENAPI } })).status, 400)
  assert.equal((await call('POST', '/personal/connectors', { openapi: {} })).status, 400)
  const notOpenApi = await call('POST', '/personal/connectors', { openapi: { spec: '{"swagger":"2.0"}' } })
  assert.equal(notOpenApi.status, 400)
  assert.match(String(notOpenApi.json.error), /Swagger 2\.0/)
  // A private address is refused before anything is fetched.
  const privateUrl = await call('POST', '/personal/connectors', { openapi: { url: 'https://10.0.0.5/openapi.json' } })
  assert.equal(privateUrl.status, 422)
  assert.match(String(privateUrl.json.error), /private address/)
})

test('[integration] a bot drafts a connector; only the user can mark reads and enable it', async () => {
  const yaml = 'id: bot-made\nbase_url: https://api.example.com\nactions:\n  - { id: quote, effect: write, method: GET, path: /q }\n'
  const out = await runCli(['--as', BOT, 'connector', 'draft', '--yaml', yaml])
  assert.equal(out.exitCode, 0, out.text)
  assert.match(out.text, /drafted connector bot-made/)

  const c = ((await call('GET', '/personal/connectors')).json.connectors as Connector[])[0]
  assert.deepEqual([c.status, c.createdByKind, action(c, 'quote').effectConfirmed], ['draft', 'bot', false])
  assert.equal((await call('PATCH', `/personal/connectors/${c.id}`, { status: 'active' })).status, 400, 'waits for the user')
  await call('PATCH', `/personal/connectors/${c.id}/actions/quote`, { effect: 'read' })
  assert.equal((await call('PATCH', `/personal/connectors/${c.id}`, { status: 'active' })).status, 200)

  // A bot may not declare reads, or open a draft to ad-hoc tasks.
  const reads = await runCli(['--as', BOT, 'connector', 'draft', '--yaml', yaml.replace('bot-made', 'bot-reads').replace('effect: write', 'effect: read')])
  assert.notEqual(reads.exitCode, 0)
  assert.match(reads.text, /must mark every action effect: write/)
  const invalid = await runCli(['--as', BOT, 'connector', 'draft', '--yaml', 'id: x'])
  assert.notEqual(invalid.exitCode, 0)
  assert.match(invalid.text, /invalid connector/)

  const list = await runCli(['--as', BOT, 'connector', 'list'])
  assert.match(list.text, /bot-made {2}active \(bot draft\)/)
  assert.match(list.text, /bot-made\.quote {2}read/)
})

test('[integration] the console test call runs only read actions, and only with the host online', async () => {
  const c = (await call('POST', '/personal/connectors', { openapi: { spec: OPENAPI } })).json.connector as Connector
  const test = (body: unknown) => call('POST', `/personal/connectors/${c.id}/test`, body)
  assert.equal((await test({ action: 'get_quote', args: { symbol: 'ACME' } })).status, 400, 'still write')
  await call('PATCH', `/personal/connectors/${c.id}/actions/get_quote`, { effect: 'read' })
  assert.equal((await test({ action: 'place_order', args: { symbol: 'ACME' } })).status, 400)
  assert.equal((await test({ action: 'nope', args: {} })).status, 404)
  assert.equal((await test({ args: {} })).status, 400)
  const badArgs = await test({ action: 'get_quote', args: { symbol: 42 } })
  assert.equal(badArgs.status, 400)
  assert.match(String(badArgs.json.error), /symbol must be string/)
  // A draft can be tried, but not without a bot host.
  const noHost = await test({ action: 'get_quote', args: { symbol: 'ACME' } })
  assert.equal(noHost.status, 409)
  assert.match(String(noHost.json.error), /bot host is offline/)
})
