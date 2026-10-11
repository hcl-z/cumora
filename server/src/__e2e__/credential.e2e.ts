/**
 * Credential vault end to end (task T09, B5): a credential is sealed the
 * browser's way, relayed by the server, opened and stored by the daemon, and
 * injected into a connector call. The fixture API echoes the key back; the
 * model sees `[REDACTED:quote-key]`. Then every place the value could leak is
 * scanned: server and daemon logs, run events, messages, what the model was
 * sent, the server's credential rows and the daemon's vault file.
 *
 * Needs Postgres and Redis (see stack.ts); skipped without them unless
 * E2E_REQUIRED=1.
 */
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'
import { sealCredential } from '../broker/vault.js'
import { FakeHttp } from './fake-http.js'
import { loadCassette } from './fake-openai.js'
import { E2E_DATABASE_URL, type Stack, eventually, stackUnavailableReason, startStack } from './stack.js'

interface Conversation { id: string; title: string | null }
interface Message { id: string; authorId: string; body: string }

const SECRET = 'sk-e2e-live-7f3a91c2d4b8e605'

const unavailable = await stackUnavailableReason()
if (unavailable && process.env.E2E_REQUIRED === '1') throw new Error(`e2e stack unavailable: ${unavailable}`)

let stack: Stack | null = null
const api = new FakeHttp([{
  method: 'GET',
  path: '/quote/ACME',
  // Insists on the key, and (badly) echoes it back.
  respond: (req) => req.headers['x-api-key'] === SECRET
    ? { status: 200, body: { symbol: 'ACME', price: 42.5, echoedKey: req.headers['x-api-key'] } }
    : { status: 401, body: { error: 'missing or wrong key' } },
}])

before(async () => {
  if (unavailable) return
  await api.start()
  stack = await startStack({ cassette: await loadCassette(join(import.meta.dirname, 'cassettes', 'connector-keyed.json')) })
})

after(async () => {
  if (stack) {
    if (process.env.E2E_LOG_DIR) await stack.dumpLogs(join(process.env.E2E_LOG_DIR, 'credential.log'))
    await stack.stop()
  }
  await api.stop()
})

test('a sealed credential reaches the API and leaks nowhere', { skip: unavailable ?? false, timeout: 180_000 }, async () => {
  const s = stack!
  const yaml = [
    'id: keyed-data',
    `base_url: ${api.baseUrl}`,
    'auth: { type: header, name: X-API-Key, credential: quote-key }',
    'actions:',
    '  - id: quote',
    '    effect: read',
    '    method: GET',
    '    path: /quote/{symbol}',
    '    params: { symbol: string }',
  ].join('\n')
  const { connector } = await s.api<{ connector: { id: string } }>('/personal/connectors', { method: 'POST', body: { yaml, adhocRead: true } })
  await s.api(`/personal/connectors/${connector.id}`, { method: 'PATCH', body: { status: 'active' } })
  await s.daemon.waitFor(/\[computer\] paired as /, 60_000)

  // The daemon reports its key on its control stream; wait until it is usable.
  const key = await eventually(async () => {
    const k = await s.api<{ computerId: string; online: boolean; publicKey: Record<string, string> }>('/personal/vault-key').catch(() => null)
    return k?.online ? k : null
  }, 60_000, 'the vault key')
  const sealed = sealCredential(key.publicKey, { connector: 'keyed-data', name: 'quote-key', value: SECRET })
  const stored = await eventually(
    () => s.api<{ name: string; updatedAt: string }>(`/personal/connectors/${connector.id}/credentials`, {
      method: 'POST', body: { name: 'quote-key', computerId: key.computerId, sealed },
    }),
    30_000, 'the credential to be stored',
  )
  assert.equal(stored.name, 'quote-key')
  const detail = await s.api<{ connector: { credentials: Array<{ name: string; updatedAt: string | null }> } }>(`/personal/connectors/${connector.id}`)
  assert.ok(detail.connector.credentials[0].updatedAt, 'the console shows it as set')

  const general = await eventually(async () => {
    const convos = await s.api<Conversation[]>('/conversations')
    return convos.find((c) => c.title === '总群') ?? null
  }, 30_000, '总群')
  await s.api(`/conversations/${general.id}/messages`, { method: 'POST', body: { body: '@Chief E2E-KEYED ACME 多少钱？' } })
  const reply = await eventually(async () => {
    const msgs = await s.api<Message[]>(`/conversations/${general.id}/messages`)
    return msgs.find((m) => m.body.includes('E2E-KEYED-ANSWER')) ?? null
  }, 120_000, "Chief's answer")
  assert.equal(reply.body, 'E2E-KEYED-ANSWER ACME 42.5 [ev_1]')

  // The API got the real key, once.
  assert.equal(api.requests.length, 1)
  assert.equal(api.requests[0].headers['x-api-key'], SECRET)

  // The model saw the echo, redacted.
  const modelInput = s.openai.received.map((r) => r.input).join('\n')
  assert.match(modelInput, /\[REDACTED:quote-key\]/)

  // B5: scan everywhere the value could have gone.
  const db = new pg.Client({ connectionString: E2E_DATABASE_URL })
  await db.connect()
  try {
    const [events, messages, credentials, computers] = await Promise.all([
      db.query(`SELECT kind, title, data::text AS data FROM agent_events`),
      db.query(`SELECT body FROM messages`),
      db.query(`SELECT * FROM connector_credentials`),
      db.query(`SELECT vault_public_key::text AS k FROM computers`),
    ])
    const places: Record<string, string> = {
      'server log': s.server.lines.join('\n'),
      'daemon log': s.daemon.lines.join('\n'),
      'run events': JSON.stringify(events.rows),
      messages: JSON.stringify(messages.rows),
      'connector_credentials': JSON.stringify(credentials.rows),
      'computers.vault_public_key': JSON.stringify(computers.rows),
      'model input': modelInput,
    }
    // Every file the daemon wrote: the vault, loop history, agent homes, logs.
    for (const rel of await readdir(join(s.home, '.cumora'), { recursive: true })) {
      const path = join(s.home, '.cumora', rel)
      if ((await stat(path)).isFile()) places[`~/.cumora/${rel}`] = await readFile(path, 'latin1')
    }
    assert.ok(places['~/.cumora/vault.enc.json'], 'the vault file exists')
    const forms = [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString('base64')]
    const hits = Object.entries(places).filter(([, text]) => forms.some((f) => text.includes(f))).map(([where]) => where)
    assert.deepEqual(hits, [], `the credential value leaked into: ${hits.join(', ')}`)
    assert.equal(credentials.rows.length, 1)
    assert.deepEqual(Object.keys(credentials.rows[0]).sort(), ['connector_id', 'name', 'updated_at'])
  } finally {
    await db.end()
  }
})
