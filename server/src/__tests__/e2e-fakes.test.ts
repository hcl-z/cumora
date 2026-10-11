/**
 * The e2e fakes themselves (server/src/__e2e__): replay matching and
 * templating, the loud failure on an unmatched agent request, record
 * redaction, and the fixture HTTP service. The loop engine's own streamer is
 * the client, so a cassette is known to decode the way the daemon reads it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeHttp } from '../__e2e__/fake-http.js'
import { type Cassette, FakeOpenAI, flattenInput, textEvents, toolCallEvents } from '../__e2e__/fake-openai.js'
import { completeText, createResponsesStreamer } from '../agents/computer/loop/responses.js'
import { applyResponseStreamEvent, consumeResponseStream, newResponseStreamState } from '../agents/turn-stream.js'

const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] }) as never
const tool = { type: 'function', name: 't', parameters: {}, strict: false } as never

async function agentHop(baseUrl: string, text: string) {
  const state = newResponseStreamState()
  await consumeResponseStream(
    createResponsesStreamer({ apiKey: 'k', baseUrl })({ model: 'm', input: [user(text)], tools: [tool] }, new AbortController().signal),
    (ev) => applyResponseStreamEvent(state, ev),
  )
  return Object.values(state.pendingTools)
}

test('replay matches by kind and input, fills captured groups, and uses each interaction once', async () => {
  const cassette: Cassette = {
    version: 1,
    interactions: [
      { kind: 'agent', match: 'PING.*?(?<convo>c-\\d+)', events: toolCallEvents([{ name: 'reply', args: { to: '{{convo}}' } }]) },
      { kind: 'oneshot', events: textEvents('{"actionable":true}') },
    ],
  }
  const fake = new FakeOpenAI({ cassette })
  const baseUrl = await fake.start()
  try {
    const calls = await agentHop(baseUrl, 'PING from c-42')
    assert.equal(calls.length, 1)
    assert.deepEqual(JSON.parse(calls[0].arguments), { to: 'c-42' })

    const one = await completeText(createResponsesStreamer({ apiKey: 'k', baseUrl }), { model: 'small', prompt: 'triage?' }, new AbortController().signal)
    assert.equal(one.text, '{"actionable":true}')

    await assert.rejects(agentHop(baseUrl, 'PING from c-42'), /HTTP 500[\s\S]*no cassette interaction/)
    assert.equal(fake.unmatched.length, 1)
    assert.equal(fake.unusedInteractions().length, 0)
    assert.deepEqual(fake.received.map((r) => [r.kind, r.matched]), [['agent', 0], ['oneshot', 1], ['agent', null]])
  } finally {
    await fake.stop()
  }
})

test('an unmatched one-shot gets the fallback answer when the cassette has one', async () => {
  const fake = new FakeOpenAI({ cassette: { version: 1, interactions: [], fallbackOneshot: 'fallback' } })
  const baseUrl = await fake.start()
  try {
    const r = await completeText(createResponsesStreamer({ apiKey: 'k', baseUrl }), { model: 'm', prompt: 'x' }, new AbortController().signal)
    assert.equal(r.text, 'fallback')
    assert.equal(fake.unmatched.length, 0)
  } finally {
    await fake.stop()
  }
})

test('record mode relays the upstream stream and saves it with run-specific values redacted', async () => {
  const upstream = new FakeOpenAI({ cassette: { version: 1, interactions: [{ kind: 'agent', events: toolCallEvents([{ name: 'reply', args: { to: 'c-777' } }]) }] } })
  const upstreamUrl = await upstream.start()
  const recorder = new FakeOpenAI({ upstream: { baseUrl: upstreamUrl, apiKey: 'k' }, redact: { 'c-777': 'convo' } })
  const baseUrl = await recorder.start()
  try {
    const calls = await agentHop(baseUrl, 'hello')
    assert.deepEqual(JSON.parse(calls[0].arguments), { to: 'c-777' })
    const path = `${process.env.TMPDIR ?? '/tmp'}/e2e-recorded-${process.pid}.json`
    await recorder.save(path)
    const saved = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as Cassette
    assert.equal(saved.interactions.length, 1)
    assert.equal(saved.interactions[0].kind, 'agent')
    assert.match(JSON.stringify(saved), /\{\{convo\}\}/)
    assert.doesNotMatch(JSON.stringify(saved), /c-777/)
    await (await import('node:fs/promises')).rm(path, { force: true })
  } finally {
    await recorder.stop()
    await upstream.stop()
  }
})

test('flattenInput reaches message text, tool arguments and tool outputs', () => {
  const text = flattenInput({
    input: [
      user('hello'),
      { type: 'function_call', call_id: 'a', name: 'n', arguments: '{"argv":["reply"]}' },
      { type: 'function_call_output', call_id: 'a', output: 'posted' },
    ],
  })
  assert.match(text, /hello/)
  assert.match(text, /argv/)
  assert.match(text, /posted/)
})

test('the fixture HTTP service answers routes and records every request', async () => {
  const http = new FakeHttp([{ method: 'GET', path: '/quote', body: { price: 42 } }])
  const base = await http.start()
  try {
    const ok = await fetch(`${base}/quote?symbol=X`)
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { price: 42 })
    const missing = await fetch(`${base}/nope`, { method: 'POST', body: 'x' })
    assert.equal(missing.status, 404)
    assert.deepEqual(http.requests.map((r) => [r.method, r.path, r.query.symbol ?? null, r.body]), [
      ['GET', '/quote', 'X', ''],
      ['POST', '/nope', null, 'x'],
    ])
  } finally {
    await http.stop()
  }
})
