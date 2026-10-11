/**
 * Personal-mode connectors against a real Postgres (task T08): the REST
 * create / list / detail / update round-trip with its `connector.changed`
 * outbox row, the ad-hoc broker scope, and every branch of the per-call
 * authorization the daemon's Broker must pass.
 *
 * Run: INTEGRATION_DATABASE_URL=… npm run test:integration
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { authorizeConnectorCall, brokerScope } from '../personal/connectors.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'

const COMPANY = 'co-connectors-test'
const OWNER = 'u-conn-owner'

const YAML = `
id: market-data
name: Market data
base_url: https://api.example.com/v1
actions:
  - id: quote
    effect: read
    method: GET
    path: /quote/{symbol}
    params: { symbol: string }
  - id: place_order
    effect: write
    method: POST
    path: /orders
    params: { symbol: string }
`

let server: Server
let base: string
const personalModeBefore = env.PERSONAL_MODE

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-company-id': COMPANY },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

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
  await pool.query(`INSERT INTO companies (id, name, slug) VALUES ($1, 'Connectors', 'connectors-ws')`, [COMPANY])
  await seedUserMembership(OWNER, COMPANY)
})
after(async () => {
  ;(env as { PERSONAL_MODE: boolean }).PERSONAL_MODE = personalModeBefore
  await teardownAll(server)
})

test('[integration] a connector is created as a draft, listed, read back and updated', async () => {
  const created = await call('POST', '/personal/connectors', { yaml: YAML, adhocRead: true, requestId: 'req-1' })
  assert.equal(created.status, 201)
  const connector = created.json.connector as { id: string; status: string; slug: string; adhocRead: boolean; actions: Array<{ id: string; effect: string }> }
  assert.equal(connector.status, 'draft')
  assert.equal(connector.slug, 'market-data')
  assert.equal(connector.adhocRead, true)
  assert.deepEqual(connector.actions.map((a) => [a.id, a.effect]), [['place_order', 'write'], ['quote', 'read']])

  // The same requestId replays instead of creating a second row.
  const replay = await call('POST', '/personal/connectors', { yaml: YAML, adhocRead: true, requestId: 'req-1' })
  assert.equal(replay.status, 200)
  assert.equal((replay.json.connector as { id: string }).id, connector.id)
  // A different request for the same slug is a conflict.
  assert.equal((await call('POST', '/personal/connectors', { yaml: YAML, adhocRead: false })).status, 409)

  const list = await call('GET', '/personal/connectors')
  assert.equal((list.json.connectors as unknown[]).length, 1)
  const detail = await call('GET', `/personal/connectors/${connector.id}`)
  assert.match(String((detail.json.connector as { definitionYaml: string }).definitionYaml), /place_order/)

  const enabled = await call('PATCH', `/personal/connectors/${connector.id}`, { status: 'active' })
  assert.equal((enabled.json.connector as { status: string }).status, 'active')

  const outbox = await pool.query<{ payload: { type: string; kind: string; connectorId: string; companyId: string } }>(
    `SELECT payload FROM realtime_outbox WHERE payload->>'type' = 'connector.changed' ORDER BY created_at`,
  )
  assert.deepEqual(outbox.rows.map((r) => [r.payload.kind, r.payload.connectorId, r.payload.companyId]), [
    ['connector.created', connector.id, COMPANY],
    ['connector.updated', connector.id, COMPANY],
  ])
})

test('[integration] invalid definitions and bad updates are refused with 400', async () => {
  const bad = await call('POST', '/personal/connectors', { yaml: YAML.replace('https://', 'http://') })
  assert.equal(bad.status, 400)
  assert.match(String(bad.json.error), /must use https/)
  assert.ok(Array.isArray(bad.json.problems))
  assert.equal((await call('POST', '/personal/connectors', {})).status, 400)
  const created = await call('POST', '/personal/connectors', { yaml: YAML })
  const id = (created.json.connector as { id: string }).id
  assert.equal((await call('PATCH', `/personal/connectors/${id}`, { status: 'live' })).status, 400)
  assert.equal((await call('PATCH', `/personal/connectors/${id}`, {})).status, 400)
  assert.equal((await call('PATCH', '/personal/connectors/con_missing', { status: 'active' })).status, 404)
})

test('[integration] connectors are personal-mode only', async () => {
  ;(env as { PERSONAL_MODE: boolean }).PERSONAL_MODE = false
  try {
    assert.equal((await call('GET', '/personal/connectors')).status, 404)
  } finally {
    ;(env as { PERSONAL_MODE: boolean }).PERSONAL_MODE = true
  }
})

test('[integration] the ad-hoc scope holds only read actions of active, ad-hoc connectors', async () => {
  const created = await call('POST', '/personal/connectors', { yaml: YAML, adhocRead: false })
  const id = (created.json.connector as { id: string }).id
  assert.deepEqual(await brokerScope(COMPANY), [])
  await call('PATCH', `/personal/connectors/${id}`, { status: 'active' })
  assert.deepEqual(await brokerScope(COMPANY), [], 'active but not open to ad-hoc tasks')
  await call('PATCH', `/personal/connectors/${id}`, { adhocRead: true })
  const scope = await brokerScope(COMPANY)
  assert.equal(scope.length, 1)
  assert.deepEqual(scope[0].actions.map((a) => a.name), ['market-data.quote'])
  assert.deepEqual(scope[0].definition.actions.map((a) => a.id), ['quote'])
  // Another workspace sees nothing.
  assert.deepEqual(await brokerScope('co-elsewhere'), [])
})

test('[integration] authorization allows exactly the ad-hoc read path and names why it denies', async () => {
  const created = await call('POST', '/personal/connectors', { yaml: YAML, adhocRead: true })
  const id = (created.json.connector as { id: string }).id
  const verdict = (action: string) => authorizeConnectorCall({ companyId: COMPANY, action })

  assert.match((await verdict('market-data.quote') as { reason: string }).reason, /is draft/)
  await call('PATCH', `/personal/connectors/${id}`, { status: 'active' })

  const allowed = await verdict('market-data.quote')
  assert.equal(allowed.decision, 'allow')
  if (allowed.decision === 'allow') assert.deepEqual(allowed.definition.actions.map((a) => a.id), ['quote'])

  assert.match((await verdict('market-data.place_order') as { reason: string }).reason, /write actions need an approval/)
  assert.match((await verdict('market-data.nope') as { reason: string }).reason, /has no action nope/)
  assert.match((await verdict('other.quote') as { reason: string }).reason, /no connector named other/)
  assert.match((await verdict('not-an-action') as { reason: string }).reason, /not a <connector>\.<action> name/)
  assert.equal((await authorizeConnectorCall({ companyId: 'co-elsewhere', action: 'market-data.quote' })).decision, 'deny')

  await call('PATCH', `/personal/connectors/${id}`, { adhocRead: false })
  assert.match((await verdict('market-data.quote') as { reason: string }).reason, /not open to ad-hoc tasks/)
})
