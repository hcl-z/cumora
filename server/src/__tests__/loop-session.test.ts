/**
 * The `loop` engine's hop loop, driven by a scripted fake of the Responses
 * stream so no network or key is involved. Pins the turn protocol (a turn
 * ends only on a terminal set_turn_status), steering at hop boundaries, the
 * failure kinds the daemon's throttling and auth hints key on, and the usage
 * shape the ledger reads.
 */
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { LoopSession, engineUsageFromOpenAI } from '../agents/computer/loop/session.js'
import { ResponsesError, type ResponsesRequest, classifyResponsesFailure, sseData } from '../agents/computer/loop/responses.js'
import { CUMORA_TOOL_NAME } from '../agents/computer/loop/tools.js'

let home: string
before(async () => { home = await realpath(await mkdtemp(join(tmpdir(), 'loop-session-'))) })
after(async () => { await rm(home, { recursive: true, force: true }) })

type Call = { name: string; args: unknown }
type Hop = { calls?: Call[]; text?: string; usage?: { input: number; cached?: number; output: number } } | Error

/** A scripted stream: each send() hop takes the next entry. */
function scripted(hops: Hop[]) {
  const requests: ResponsesRequest[] = []
  let i = 0
  const stream = (req: ResponsesRequest): AsyncIterable<ResponseStreamEvent> => {
    requests.push({ ...req, input: [...req.input] })
    const hop = hops[i++]
    return (async function* () {
      if (!hop) throw new Error('script exhausted')
      if (hop instanceof Error) throw hop
      if (hop.text) yield { type: 'response.output_text.done', item_id: 'm', content_index: 0, text: hop.text } as unknown as ResponseStreamEvent
      for (const [n, c] of (hop.calls ?? []).entries()) {
        yield {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: `fc${i}-${n}`, call_id: `call${i}-${n}`, name: c.name, arguments: JSON.stringify(c.args) },
        } as unknown as ResponseStreamEvent
      }
      const u = hop.usage ?? { input: 10, output: 5 }
      yield {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: u.input, output_tokens: u.output, input_tokens_details: { cached_tokens: u.cached ?? 0 } } },
      } as unknown as ResponseStreamEvent
    })()
  }
  return { stream, requests }
}

const status = (s: string): Call => ({ name: 'set_turn_status', args: { status: s, reason: 'r', next_step: '' } })

function session(hops: Hop[], cli = async (_argv: string[]) => ({ text: 'ok', exitCode: 0 })) {
  const { stream, requests } = scripted(hops)
  const hopReports: unknown[] = []
  const s = new LoopSession({
    home, model: 'gpt-5.5', instructions: 'standing prompt', config: null,
    runtimeCli: cli, onLog: () => {}, onHopUsage: (r) => hopReports.push(r), stream,
  })
  return { s, requests, hopReports }
}

test('a turn acts through the Cumora tool and ends on a terminal status', async () => {
  const argvs: string[][] = []
  const { s, requests, hopReports } = session([
    { calls: [{ name: CUMORA_TOOL_NAME, args: { argv: ['reply', 'c1', 'hi'] } }], usage: { input: 100, cached: 40, output: 20 } },
    { calls: [status('done')], usage: { input: 120, cached: 100, output: 5 } },
  ], async (argv) => { argvs.push(argv); return { text: 'posted', exitCode: 0 } })
  const r = await s.send('wake')
  assert.equal(r.exitCode, 0)
  assert.deepEqual(argvs, [['reply', 'c1', 'hi']])
  assert.equal(requests[0].instructions, 'standing prompt')
  assert.equal(requests[0].model, 'gpt-5.5')
  // Uncached input, cache reads and output summed across both hops.
  assert.deepEqual(r.usage, { input_tokens: 80, cache_read_input_tokens: 140, output_tokens: 25 })
  assert.equal(hopReports.length, 2)
  // The second hop saw the call and its output in history.
  const second = requests[1].input.map((it) => (it as { type?: string }).type ?? 'message')
  assert.deepEqual(second, ['message', 'function_call', 'function_call_output'])
})

test('a non-terminal status keeps the turn going', async () => {
  const { s, requests } = session([{ calls: [status('continue')] }, { calls: [status('done')] }])
  assert.equal((await s.send('wake')).exitCode, 0)
  assert.equal(requests.length, 2)
})

test('plain text without a status is nudged, then the turn fails after the limit', async () => {
  const { s, requests } = session([{ text: 'all good' }, { text: 'still talking' }, { text: 'again' }])
  const r = await s.send('wake')
  assert.equal(r.exitCode, 1)
  assert.match(r.error ?? '', /missing turn-status declarations/)
  assert.equal(r.failure?.kind, 'unknown')
  assert.equal(requests.length, 3)
  const nudge = JSON.stringify(requests[1].input.at(-1))
  assert.match(nudge, /cannot see plain assistant output/)
})

test('a message steered in mid-turn is delivered before the turn may end', async () => {
  const { s, requests } = session([
    { calls: [{ name: CUMORA_TOOL_NAME, args: { argv: ['whoami'] } }] },
    { calls: [status('done')] },
    { calls: [status('done')] },
  ], async () => {
    s.steer('@you urgent question')
    return { text: 'ok', exitCode: 0 }
  })
  assert.equal((await s.send('wake')).exitCode, 0)
  assert.match(JSON.stringify(requests[1].input.at(-1)), /urgent question/)
})

test('history carries across turns in one session', async () => {
  const { s, requests } = session([{ calls: [status('done')] }, { calls: [status('done')] }])
  await s.send('first')
  await s.send('second')
  const texts = JSON.stringify(requests[1].input)
  assert.match(texts, /first/)
  assert.match(texts, /second/)
})

test('the hop limit stops a runaway turn', async () => {
  const { stream } = scripted(Array.from({ length: 5 }, () => ({ calls: [status('continue')] })))
  const s = new LoopSession({ home, model: 'm', instructions: '', config: null, runtimeCli: null, onLog: () => {}, stream, maxHops: 3 })
  const r = await s.send('wake')
  assert.equal(r.exitCode, 1)
  assert.match(r.error ?? '', /3-hop limit/)
})

test('provider failures surface as the EngineFailure kinds the daemon acts on', async () => {
  const rl = session([new ResponsesError('OpenAI rate limited (HTTP 429): slow down', 'rate-limit', 429)])
  const r = await rl.s.send('wake')
  assert.equal(r.failure?.kind, 'rate-limit')
  assert.match(r.error ?? '', /rate limit/i)

  const noKey = new LoopSession({ home, model: 'm', instructions: '', config: null, runtimeCli: null, onLog: () => {} })
  const missing = await noKey.send('wake')
  assert.equal(missing.failure?.kind, 'authentication')
  assert.match(missing.error ?? '', /api key/i)
})

test('failure classification matches the HTTP status and message', () => {
  assert.equal(classifyResponsesFailure(429, ''), 'rate-limit')
  assert.equal(classifyResponsesFailure(401, ''), 'authentication')
  assert.equal(classifyResponsesFailure(400, "This model's maximum context length is 128000 tokens"), 'context-overflow')
  assert.equal(classifyResponsesFailure(503, ''), 'transport')
  assert.equal(classifyResponsesFailure(null, 'socket hang up'), 'transport')
  assert.equal(classifyResponsesFailure(400, 'bad request'), 'unknown')
})

test('OpenAI usage maps to uncached input plus cache reads', () => {
  assert.deepEqual(
    engineUsageFromOpenAI({ input_tokens: 50, output_tokens: 7, input_tokens_details: { cached_tokens: 30 } }),
    { input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 7 },
  )
  assert.deepEqual(engineUsageFromOpenAI(null), { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 })
})

test('SSE events split across chunks and multi-byte characters are reassembled', async () => {
  const payload = 'data: {"type":"a","t":"中文"}\n\ndata: {"type":"b"}\n\n'
  const bytes = Buffer.from(payload, 'utf8')
  // Cut inside the multi-byte character and inside the event boundary.
  const cut1 = payload.indexOf('中') + 1
  const chunks = [bytes.subarray(0, cut1), bytes.subarray(cut1, bytes.length - 3), bytes.subarray(bytes.length - 3)]
  const got: string[] = []
  for await (const d of sseData((async function* () { yield* chunks })())) got.push(d)
  assert.deepEqual(got.map((d) => JSON.parse(d).type), ['a', 'b'])
  assert.equal(JSON.parse(got[0]).t, '中文')
})
