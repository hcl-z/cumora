/**
 * The connector boundary (task T08): which addresses are unreachable, how a
 * YAML definition is validated, the HTTP executor's limits (https only,
 * private addresses refused before and after DNS, 2MB, timeout, rate limit)
 * and the Broker's deny / evidence paths. No external network: blocked cases
 * fail before a socket opens, and the size/timeout cases use a loopback
 * fixture with the test-only loopback switch.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { Broker, type BrokerEvent, argsHash } from '../broker/broker.js'
import { type ConnectorDefinition, buildRequest, isPrivateAddress, splitActionName, validateArgs } from '../broker/definition.js'
import { ConnectorCallError, RateLimiter, checkUrl, executeHttp } from '../broker/http-executor.js'
import { ConnectorSchemaError, parseConnectorYaml } from '../personal/connector-schema.js'
import { Redactor } from '../broker/vault.js'
import { CUMORA_TOOL_NAME, loopToolDefs, runTool } from '../agents/computer/loop/tools.js'

// ── address policy ────────────────────────────────────────────────────────

test('private, loopback, link-local, CGNAT, multicast and reserved addresses are blocked', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1',
    '64:ff9b::a00:1', '2001:db8::1', 'not-an-ip',
  ]) assert.equal(isPrivateAddress(ip), true, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip)
  }
})

// ── YAML definition ───────────────────────────────────────────────────────

const VALID = `
id: market-data
name: Market data
base_url: https://api.example.com/v1/
rate_limit: { per_minute: 30 }
actions:
  - id: quote
    effect: read
    method: GET
    path: /quote/{symbol}
    params: { symbol: string, fields: string? }
    description: Latest quote
  - id: place_order
    effect: write
    method: POST
    path: /orders
    params: { symbol: string, qty: integer }
`

test('a valid definition parses into a normalized shape', () => {
  const def = parseConnectorYaml(VALID)
  assert.equal(def.slug, 'market-data')
  assert.equal(def.baseUrl, 'https://api.example.com/v1')
  assert.equal(def.rateLimitPerMinute, 30)
  assert.deepEqual(def.actions.map((a) => [a.id, a.effect, a.method]), [['quote', 'read', 'GET'], ['place_order', 'write', 'POST']])
  assert.deepEqual(def.actions[0].params, { symbol: { type: 'string', required: true }, fields: { type: 'string', required: false } })
})

test('invalid definitions report every problem', () => {
  const bad = (src: string, re: RegExp, opts = {}) => {
    assert.throws(() => parseConnectorYaml(src, opts), (err: unknown) => err instanceof ConnectorSchemaError && re.test(err.problems.join('\n')), src)
  }
  bad('id: x\nbase_url: https://a.example\nactions: []', /id must match[\s\S]*actions must be a non-empty list/)
  bad('id: abc\nbase_url: http://api.example.com\nactions: [{id: a, effect: read, path: /a}]', /must use https/)
  bad('id: abc\nbase_url: http://127.0.0.1:9\nactions: [{id: a, effect: read, path: /a}]', /must use https/)
  bad('id: abc\nbase_url: https://u:p@a.example\nactions: [{id: a, effect: read, path: /a}]', /embed credentials/)
  bad('id: abc\nbase_url: https://a.example\nactions: [{id: a, effect: read, method: POST, path: /a}]', /POST action cannot be marked read/)
  bad('id: abc\nbase_url: https://a.example\nactions: [{id: a, effect: read, path: "/a/{x}"}]', /\{x\} has no matching param/)
  bad('id: abc\nbase_url: https://a.example\nactions: [{id: a, effect: read, path: /../a}]', /path must start with/)
  bad('id: abc\nbase_url: https://a.example\nauth: {type: header}\nactions: [{id: a, effect: read, path: /a}]', /auth\.credential must match/)
  bad('id: abc\nbase_url: https://a.example\nauth: {type: header, name: Host, credential: k1}\nactions: [{id: a, effect: read, path: /a}]', /Host cannot be used/)
  bad('id: abc\nbase_url: https://a.example\nauth: {type: cookie, credential: k1}\nactions: [{id: a, effect: read, path: /a}]', /auth\.type must be/)
  bad('id: abc\nbase_url: https://a.example\nauth: {type: query, name: q, credential: k1}\nactions: [{id: a, effect: read, path: /a, params: {q: string}}]', /also a param of action a/)
  bad('id: abc\nbase_url: https://a.example\nactions: [{id: a, effect: read, path: /a}, {id: a, effect: read, path: /b}]', /duplicate action id a/)
  bad('{{not yaml', /YAML/)
  // The loopback switch admits exactly http://127.0.0.1, nothing else.
  assert.equal(parseConnectorYaml('id: abc\nbase_url: http://127.0.0.1:9\nactions: [{id: a, effect: read, path: /a}]', { allowLoopbackHttp: true }).baseUrl, 'http://127.0.0.1:9')
  bad('id: abc\nbase_url: http://10.0.0.1\nactions: [{id: a, effect: read, path: /a}]', /must use https/, { allowLoopbackHttp: true })
})

test('auth names a vault credential and places it after the args', () => {
  const header = parseConnectorYaml('id: abc\nbase_url: https://a.example\nauth: {type: header, name: X-API-Key, credential: abc-key}\nactions: [{id: a, effect: read, path: /a, params: {x: string?}}]')
  assert.deepEqual(header.auth, { type: 'header', name: 'X-API-Key', credential: 'abc-key' })
  const r = buildRequest(header, header.actions[0], { x: '1' }, 'secret-value')
  assert.equal(r.headers['X-API-Key'], 'secret-value')
  assert.throws(() => buildRequest(header, header.actions[0], {}, null), /credential abc-key is not set/)

  const bearer = parseConnectorYaml('id: abc\nbase_url: https://a.example\nauth: {type: bearer, credential: abc-key}\nactions: [{id: a, effect: read, path: /a}]')
  assert.equal(buildRequest(bearer, bearer.actions[0], {}, 'tok-123').headers.Authorization, 'Bearer tok-123')

  const query = parseConnectorYaml('id: abc\nbase_url: https://a.example\nauth: {type: query, name: apikey, credential: abc-key}\nactions: [{id: a, effect: read, path: /a, params: {x: string?}}]')
  assert.equal(buildRequest(query, query.actions[0], { x: '1' }, 'qk-999').url.searchParams.get('apikey'), 'qk-999')
})

test('requests keep path params inside their segment and the base URL', () => {
  const def = parseConnectorYaml(VALID)
  const quote = def.actions[0]
  const r = buildRequest(def, quote, { symbol: '../../admin?x=1', fields: 'px' })
  assert.equal(r.url.pathname, '/v1/quote/..%2F..%2Fadmin%3Fx%3D1')
  assert.equal(r.url.searchParams.get('fields'), 'px')
  assert.equal(r.body, null)
  const order = buildRequest(def, def.actions[1], { symbol: 'X', qty: 2 })
  assert.equal(order.body, '{"symbol":"X","qty":2}')
  assert.deepEqual(validateArgs(quote, { symbol: 1, extra: true }), ['unknown param: extra', 'param symbol must be string'])
  assert.deepEqual(validateArgs(quote, {}), ['missing required param: symbol'])
  assert.deepEqual(splitActionName('market-data.quote'), { slug: 'market-data', actionId: 'quote' })
  assert.equal(splitActionName('quote'), null)
})

// ── HTTP executor ─────────────────────────────────────────────────────────

let fixture: Server
let fixtureUrl: string
before(async () => {
  fixture = createServer((req, res) => {
    if (req.url?.startsWith('/big')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      const chunk = Buffer.alloc(256 * 1024, 120)
      for (let i = 0; i < 10; i++) res.write(chunk) // 2.5MB, no content-length
      res.end()
      return
    }
    if (req.url?.startsWith('/slow')) { setTimeout(() => { res.writeHead(200); res.end('late') }, 2000); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, method: req.method }))
  })
  await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done))
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`
})
after(async () => {
  fixture.closeAllConnections()
  await new Promise<void>((done) => fixture.close(() => done()))
})

function loopbackDef(): ConnectorDefinition {
  return {
    slug: 'fixture', kind: 'http', baseUrl: fixtureUrl, rateLimitPerMinute: 60,
    actions: [
      { id: 'echo', effect: 'read', method: 'GET', path: '/echo/{id}', params: { id: { type: 'string', required: true } } },
      { id: 'big', effect: 'read', method: 'GET', path: '/big', params: {} },
      { id: 'slow', effect: 'read', method: 'GET', path: '/slow', params: {} },
    ],
  }
}

async function rejectsWith(p: Promise<unknown>, reason: ConnectorCallError['reason'], re: RegExp) {
  await assert.rejects(p, (err: unknown) => err instanceof ConnectorCallError && err.reason === reason && re.test(err.message))
}

test('plain http, private literals and local names are refused before any socket opens', async () => {
  const def = loopbackDef()
  const echo = def.actions[0]
  await rejectsWith(executeHttp(def, echo, { id: '1' }), 'blocked', /must use https/)
  for (const url of ['https://10.0.0.5/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://db.internal/x']) {
    assert.throws(() => checkUrl(new URL(url), false), /private address|local hostname/, url)
  }
  // The loopback switch admits loopback over http, and nothing else.
  assert.doesNotThrow(() => checkUrl(new URL('http://127.0.0.1:1/x'), true))
  assert.throws(() => checkUrl(new URL('http://10.0.0.5/x'), true), /must use https/)
  assert.throws(() => checkUrl(new URL('https://192.168.0.2/x'), true), /private address/)
})

test('a public name that resolves to a private address is refused at connect time', async () => {
  const def: ConnectorDefinition = { ...loopbackDef(), baseUrl: 'https://rebind.example.com' }
  await rejectsWith(
    executeHttp(def, def.actions[0], { id: '1' }, { resolve: async () => [{ address: '10.0.0.7', family: 4 }] }),
    'blocked', /resolves to a private address \(10\.0\.0\.7\)/,
  )
  await rejectsWith(
    executeHttp(def, def.actions[0], { id: '1' }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] }),
    'blocked', /127\.0\.0\.1/,
  )
})

test('a response over 2MB is cut off and refused; a slow one times out', async () => {
  const def = loopbackDef()
  const ok = await executeHttp(def, def.actions[0], { id: 'a b' }, { allowLoopbackHttp: true })
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body.toString()), { path: '/echo/a%20b', method: 'GET' })
  await rejectsWith(executeHttp(def, def.actions[1], {}, { allowLoopbackHttp: true }), 'too_large', /2097152-byte limit/)
  await rejectsWith(executeHttp(def, def.actions[2], {}, { allowLoopbackHttp: true, timeoutMs: 150 }), 'timeout', /within 150ms/)
})

test('the rate limiter allows a burst up to the limit, then refills over time', () => {
  let t = 0
  const rl = new RateLimiter(() => t)
  for (let i = 0; i < 3; i++) assert.equal(rl.take('c', 3), true)
  assert.equal(rl.take('c', 3), false)
  assert.equal(rl.take('other', 3), true)
  t += 20_000 // one third of a minute → one token back
  assert.equal(rl.take('c', 3), true)
  assert.equal(rl.take('c', 3), false)
})

// ── Broker ────────────────────────────────────────────────────────────────

function makeBroker(verdict: 'allow' | 'deny', events: BrokerEvent[] = []) {
  const def = loopbackDef()
  const authorizeCalls: Array<{ action: string; argsHash: string; runId: string | null }> = []
  const broker = new Broker({
    fetchScope: async () => [{
      slug: 'fixture', name: 'Fixture', description: null, definition: def,
      actions: [{ name: 'fixture.echo', effect: 'read', description: 'echo', paramsSchema: { type: 'object' } }],
    }],
    authorize: async (req) => {
      authorizeCalls.push(req)
      return verdict === 'allow'
        ? { decision: 'allow', definition: { ...def, actions: [def.actions[0]] }, effect: 'read' }
        : { decision: 'deny', reason: 'fixture.secret is not in your scope' }
    },
    recordEvent: (e) => events.push(e),
    currentRunId: () => 'run-1',
    allowLoopbackHttp: true,
  })
  return { broker, authorizeCalls, events }
}

test('an allowed read returns numbered, untrusted evidence and is audited', async () => {
  const { broker, authorizeCalls, events } = makeBroker('allow')
  broker.beginTurn()
  const first = JSON.parse((await broker.call('fixture.echo', { id: 'x' })).output)
  const second = JSON.parse((await broker.call('fixture.echo', { id: 'y' })).output)
  assert.equal(first.evidence_id, 'ev_1')
  assert.equal(second.evidence_id, 'ev_2')
  assert.equal(first.untrusted, true)
  assert.deepEqual(first.source.connector, 'fixture')
  assert.deepEqual(first.data, { path: '/echo/x', method: 'GET' })
  assert.equal(authorizeCalls[0].runId, 'run-1')
  assert.equal(authorizeCalls[0].argsHash, argsHash({ id: 'x' }))
  assert.equal(events.length, 2)
  assert.equal(events[0].kind, 'connector.call')
  assert.equal(events[0].data.evidenceId, 'ev_1')
  broker.beginTurn()
  assert.equal(JSON.parse((await broker.call('fixture.echo', { id: 'z' })).output).evidence_id, 'ev_1')
})

test('a denied call returns DENIED and never executes', async () => {
  const { broker, events } = makeBroker('deny')
  const r = await broker.call('fixture.secret', {})
  assert.match(r.output, /^exit 3\nDENIED: fixture\.secret is not in your scope/)
  // The server records the denial; the Broker does not double-report it.
  assert.equal(events.length, 0)
})

test('args are validated against the authorized definition before the call', async () => {
  const { broker, events } = makeBroker('allow')
  assert.match((await broker.call('fixture.echo', { id: 3 })).output, /param id must be string/)
  assert.match((await broker.call('nodot', {})).output, /<connector>\.<action>/)
  assert.equal(events.length, 0)
})

test('a credential is injected from the vault and redacted from everything that leaves the Broker', async () => {
  const SECRET = 'sk-live-0123456789abcdef'
  const events: BrokerEvent[] = []
  const redactor = new Redactor()
  redactor.set([{ name: 'quote-key', value: SECRET }])
  const def: ConnectorDefinition = {
    slug: 'quotes', kind: 'http', baseUrl: 'https://api.example.com', rateLimitPerMinute: 60,
    auth: { type: 'header', name: 'X-API-Key', credential: 'quote-key' },
    actions: [{ id: 'echo', effect: 'read', method: 'GET', path: '/echo', params: { note: { type: 'string', required: false } } }],
  }
  let sentHeaders: Record<string, string> = {}
  const broker = new Broker({
    fetchScope: async () => [],
    authorize: async () => ({ decision: 'allow', definition: def, effect: 'read' }),
    recordEvent: (e) => events.push(e),
    currentRunId: () => 'run-1',
    credential: (connector, name) => (connector === 'quotes' && name === 'quote-key' ? SECRET : null),
    redact: (t) => redactor.redact(t),
    // A misbehaving API that echoes the key back in its body.
    execute: async (d, a, args, opts) => {
      sentHeaders = buildRequest(d, a, args, opts.credential).headers
      return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ youSent: SECRET, b64: Buffer.from(SECRET).toString('base64') })), durationMs: 3 }
    },
  })
  // The model even passes the key as an arg.
  const out = (await broker.call('quotes.echo', { note: `my key is ${SECRET}` })).output
  assert.equal(sentHeaders['X-API-Key'], SECRET, 'the real value goes to the API')
  assert.doesNotMatch(out, new RegExp(SECRET))
  assert.match(out, /\[REDACTED:quote-key\]/)
  const everything = JSON.stringify(events)
  assert.doesNotMatch(everything, new RegExp(SECRET))
  assert.doesNotMatch(everything, new RegExp(Buffer.from(SECRET).toString('base64')))

  // An error that carries the key (e.g. a URL in a message) is redacted too.
  const failing = new Broker({
    fetchScope: async () => [], recordEvent: (e) => events.push(e), currentRunId: () => 'run-1',
    authorize: async () => ({ decision: 'allow', definition: def, effect: 'read' }),
    credential: () => SECRET, redact: (t) => redactor.redact(t),
    execute: async () => { throw new Error(`connect failed for https://api.example.com/echo?k=${SECRET}`) },
  })
  const err = (await failing.call('quotes.echo', {})).output
  assert.doesNotMatch(err + JSON.stringify(events), new RegExp(SECRET))

  // A missing credential is a clear message, not a call without auth.
  let called = false
  const missing = new Broker({
    fetchScope: async () => [], recordEvent: () => {}, currentRunId: () => null,
    authorize: async () => ({ decision: 'allow', definition: def, effect: 'read' }),
    credential: () => null,
    execute: async () => { called = true; throw new Error('should not run') },
  })
  assert.match((await missing.call('quotes.echo', {})).output, /needs the credential quote-key, which is not set/)
  assert.equal(called, false)
})

test('the loop offers connector tools only with a Broker, and routes them to it', async () => {
  assert.ok(!loopToolDefs(false).some((t) => t.name.startsWith('connector_')))
  assert.deepEqual(loopToolDefs(true).filter((t) => t.name.startsWith('connector_')).map((t) => t.name), ['connector_list', 'connector_describe', 'connector_call'])
  const { broker } = makeBroker('allow')
  const ctx = { home: '/tmp', runtimeCli: null, signal: new AbortController().signal, broker }
  assert.match((await runTool('connector_list', '{}', ctx)).output, /fixture\.echo/)
  assert.match((await runTool('connector_call', JSON.stringify({ action: 'fixture.echo', args: { id: 'q' } }), ctx)).output, /"evidence_id":"ev_1"/)
  assert.match((await runTool('connector_call', '{}', { ...ctx, broker: null })).output, /not available/)
  assert.ok(loopToolDefs(true).some((t) => t.name === CUMORA_TOOL_NAME))
})
