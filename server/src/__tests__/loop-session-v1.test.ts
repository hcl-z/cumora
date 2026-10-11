/**
 * The `loop` engine's production mechanics (task T05), driven by a scripted
 * fake of the Responses stream: compaction, the status protocol, completion
 * verification, steer interrupting a tool batch, transport retries, 429 →
 * daemon cooldown, and history.jsonl persistence and resume.
 */
process.env.CUMORA_RUNTIME_CLIENT = 'http'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses'
import { backoffUntilFor, classifyTurnOutcome } from '../agents/computer/daemon.js'
import type { EngineHopReport } from '../agents/computer/engine.js'
import { HISTORY_FILE, loadHistory } from '../agents/computer/loop/history.js'
import { ResponsesError, type ResponsesRequest } from '../agents/computer/loop/responses.js'
import { INTERRUPTED_TOOL_OUTPUT, LoopSession, type LoopSessionOptions } from '../agents/computer/loop/session.js'
import { CUMORA_TOOL_NAME, type RuntimeCliInvoker } from '../agents/computer/loop/tools.js'

let root: string
let home: string
before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'loop-v1-')))
  home = root
})
after(async () => { await rm(root, { recursive: true, force: true }) })

type Call = { name: string; args: unknown }
type Hop = { calls?: Call[]; text?: string; usage?: { input: number; output: number } } | Error

const status = (s: string): Call => ({ name: 'set_turn_status', args: { status: s, reason: 'r', next_step: '' } })
const cli = (...argv: string[]): Call => ({ name: CUMORA_TOOL_NAME, args: { argv } })

/** Agent hops (requests with tools) and one-shot calls (summaries, verdicts)
 *  are scripted separately, since both go through the same stream. */
function scripted(agentHops: Hop[], oneShots: Array<string | Error> = []) {
  const agentRequests: ResponsesRequest[] = []
  const oneShotRequests: ResponsesRequest[] = []
  let a = 0
  let o = 0
  const stream = (req: ResponsesRequest): AsyncIterable<ResponseStreamEvent> => {
    const isAgent = (req.tools?.length ?? 0) > 0
    ;(isAgent ? agentRequests : oneShotRequests).push({ ...req, input: [...req.input] })
    const hop: Hop | undefined = isAgent ? agentHops[a++] : (() => {
      const next = oneShots[o++]
      return next instanceof Error ? next : next === undefined ? undefined : { text: next }
    })()
    const n = isAgent ? a : o
    return (async function* () {
      if (!hop) throw new Error(`script exhausted (${isAgent ? 'agent' : 'one-shot'})`)
      if (hop instanceof Error) throw hop
      if (hop.text) yield { type: 'response.output_text.done', item_id: 'm', content_index: 0, text: hop.text } as unknown as ResponseStreamEvent
      for (const [i, c] of (hop.calls ?? []).entries()) {
        yield {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: `fc${n}-${i}`, call_id: `call${n}-${i}`, name: c.name, arguments: JSON.stringify(c.args) },
        } as unknown as ResponseStreamEvent
      }
      const u = hop.usage ?? { input: 10, output: 5 }
      yield {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: u.input, output_tokens: u.output, input_tokens_details: { cached_tokens: 0 } } },
      } as unknown as ResponseStreamEvent
    })()
  }
  return { stream, agentRequests, oneShotRequests }
}

function make(
  script: ReturnType<typeof scripted>,
  extra: Partial<LoopSessionOptions> = {},
): { s: LoopSession; hops: EngineHopReport[]; logs: string[] } {
  const hops: EngineHopReport[] = []
  const logs: string[] = []
  const s = new LoopSession({
    home, model: 'gpt-5.5', fastModel: 'gpt-5.4-mini', instructions: 'standing prompt', config: null,
    runtimeCli: async () => ({ text: 'ok', exitCode: 0 }),
    onLog: (l) => logs.push(l), onHopUsage: (r) => hops.push(r),
    stream: script.stream, retryBaseMs: 0, ...extra,
  })
  return { s, hops, logs }
}

const textOf = (items: ResponseInputItem[]) => JSON.stringify(items)

// ── compaction ────────────────────────────────────────────────────────────

test('compaction folds earlier turns into a fast-model summary once past 75% of the window', async () => {
  const script = scripted(
    [{ calls: [status('done')] }, { calls: [status('done')] }],
    ['EARLIER-MEMO: asked for X in c1, delivered it'],
  )
  const { s, hops } = make(script)
  // gpt-5.5 has a 200K window, so 75% is 150K tokens; ~180K ASCII tokens of prior turn.
  await s.send(`first ${'lorem ipsum '.repeat(55_000)}`)
  const r = await s.send('second')
  assert.equal(r.exitCode, 0)
  assert.equal(script.oneShotRequests.length, 1)
  assert.equal(script.oneShotRequests[0].model, 'gpt-5.4-mini')
  const sent = textOf(script.agentRequests[1].input)
  assert.match(sent, /auto-compaction/)
  assert.match(sent, /EARLIER-MEMO/)
  assert.match(sent, /second/)
  assert.doesNotMatch(sent, /lorem ipsum lorem ipsum/)
  const compaction = hops.filter((h) => h.purpose === 'compaction')
  assert.equal(compaction.length, 1)
  assert.equal(compaction[0].model, 'gpt-5.4-mini')
})

test('a failed summary still compacts, by dropping earlier turns behind a marker', async () => {
  const script = scripted([{ calls: [status('done')] }, { calls: [status('done')] }], [new Error('summarizer down')])
  const { s } = make(script)
  await s.send(`first ${'lorem ipsum '.repeat(55_000)}`)
  assert.equal((await s.send('second')).exitCode, 0)
  const sent = textOf(script.agentRequests[1].input)
  assert.match(sent, /dropped from history to fit the context budget/)
  assert.doesNotMatch(sent, /lorem ipsum lorem ipsum/)
})

test('a turn that cannot fit even after compaction fails as context overflow', async () => {
  const script = scripted([], [])
  const { s } = make(script)
  const r = await s.send(`huge ${'lorem ipsum '.repeat(70_000)}`)
  assert.equal(r.failure?.kind, 'context-overflow')
  // The daemon's reset path keys on this wording to start the next wake fresh.
  assert.match(r.error ?? '', /context window/)
  assert.equal(script.agentRequests.length, 0)
})

// ── status protocol ───────────────────────────────────────────────────────

test('two hops in a row without a status are nudged, and the third is a protocol violation', async () => {
  const script = scripted([{ text: 'all good' }, {}, { text: 'still talking' }])
  const { s } = make(script)
  const r = await s.send('wake')
  assert.equal(r.exitCode, 1)
  assert.match(r.error ?? '', /protocol violation/)
  assert.equal(script.agentRequests.length, 3)
  assert.match(textOf(script.agentRequests[1].input.slice(-1)), /Draft assistant text:\\nall good/)
  assert.match(textOf(script.agentRequests[2].input.slice(-1)), /without declaring turn status/)
})

// ── completion verification ───────────────────────────────────────────────

const reaction = { event: 'reaction.added', command: 'react', visibleToUser: true }
const posted = { event: 'message.posted', command: 'reply', visibleToUser: true }

test('done after only a reaction is verified on the fast model, rejected, and continued', async () => {
  const script = scripted(
    [{ calls: [cli('react', 'm1', 'eyes'), status('done')] }, { calls: [cli('reply', 'c1', 'here it is')] }, { calls: [status('done')] }],
    ['{"complete":false,"reason":"only reacted","next_step":"post the report"}'],
  )
  const cliCalls: string[][] = []
  const runtimeCli: RuntimeCliInvoker = async (argv) => {
    cliCalls.push(argv)
    return { text: 'ok', exitCode: 0, sideEffects: [argv[0] === 'reply' ? posted : reaction] }
  }
  const { s, hops } = make(script, { runtimeCli })
  const r = await s.send('please write the report')
  assert.equal(r.exitCode, 0)
  assert.equal(script.oneShotRequests.length, 1, 'verified once; the reply in hop 2 needs no second check')
  assert.equal(script.oneShotRequests[0].model, 'gpt-5.4-mini')
  assert.match(textOf(script.oneShotRequests[0].input), /please write the report/)
  assert.match(textOf(script.agentRequests[1].input.slice(-1)), /terminal turn status was rejected[\s\S]*post the report/)
  assert.deepEqual(cliCalls.map((a) => a[0]), ['react', 'reply'])
  assert.ok(hops.some((h) => h.purpose === 'completion-verify' && h.model === 'gpt-5.4-mini'))
})

test('a turn that posted a reply, or had no side effects, is not verified', async () => {
  const replied = scripted([{ calls: [cli('reply', 'c1', 'hi'), status('done')] }])
  await make(replied, { runtimeCli: async () => ({ text: 'ok', exitCode: 0, sideEffects: [posted] }) }).s.send('wake')
  assert.equal(replied.oneShotRequests.length, 0)

  const quiet = scripted([{ calls: [status('done')] }])
  await make(quiet).s.send('wake')
  assert.equal(quiet.oneShotRequests.length, 0)
})

test('a verifier that fails rejects the status, and verification stops after the per-turn cap', async () => {
  const script = scripted(
    [
      { calls: [cli('react', 'm1', 'eyes'), status('done')] },
      { calls: [status('done')] },
      { calls: [status('done')] },
    ],
    ['not json at all', new ResponsesError('OpenAI request failed: boom', 'transport')],
  )
  const { s } = make(script, { runtimeCli: async () => ({ text: 'ok', exitCode: 0, sideEffects: [reaction] }) })
  const r = await s.send('wake')
  assert.equal(r.exitCode, 0)
  assert.equal(script.oneShotRequests.length, 2)
  assert.equal(script.agentRequests.length, 3)
  assert.match(textOf(script.agentRequests[1].input.slice(-1)), /completion verifier failed/)
})

// ── steering ──────────────────────────────────────────────────────────────

test('a direct-message steer aborts the running tool batch and is delivered at once', async () => {
  const script = scripted([{ calls: [cli('long-task')] }, { calls: [status('done')] }])
  let sawAbort = false
  let session: LoopSession | null = null
  const runtimeCli: RuntimeCliInvoker = (_argv, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { sawAbort = true; resolve({ text: 'late', exitCode: 0 }) }, { once: true })
    setTimeout(() => session!.steer('@chief urgent question', { interrupt: true }), 10)
  })
  const { s } = make(script, { runtimeCli })
  session = s
  const started = Date.now()
  const r = await s.send('wake')
  assert.equal(r.exitCode, 0)
  assert.ok(sawAbort, 'the tool saw its signal abort')
  assert.ok(Date.now() - started < 2000)
  const second = script.agentRequests[1].input
  const output = second.find((it) => (it as { type?: string }).type === 'function_call_output') as { output: string }
  assert.equal(output.output, INTERRUPTED_TOOL_OUTPUT)
  assert.match(textOf(second.slice(-1)), /urgent question/)
})

test('a non-interrupting steer lets the batch finish and waits for the hop boundary', async () => {
  const script = scripted([{ calls: [cli('task')] }, { calls: [status('done')] }])
  let session: LoopSession | null = null
  const runtimeCli: RuntimeCliInvoker = async (_argv, signal) => {
    session!.steer('3 new messages in the group')
    await new Promise((r) => setTimeout(r, 20))
    return { text: signal.aborted ? 'aborted' : 'finished', exitCode: 0 }
  }
  const { s } = make(script, { runtimeCli })
  session = s
  assert.equal((await s.send('wake')).exitCode, 0)
  const second = textOf(script.agentRequests[1].input)
  assert.match(second, /finished/)
  assert.match(second, /3 new messages/)
})

// ── retries and rate limits ───────────────────────────────────────────────

test('connection failures are retried twice, then the turn fails as transport', async () => {
  const drop = () => new ResponsesError('OpenAI request failed: socket hang up', 'transport')
  const recovered = scripted([drop(), drop(), { calls: [status('done')] }])
  const { s, logs } = make(recovered)
  assert.equal((await s.send('wake')).exitCode, 0)
  assert.equal(recovered.agentRequests.length, 3)
  assert.equal(logs.filter((l) => /retry \d/.test(l)).length, 2)

  const dead = scripted([drop(), drop(), drop(), { calls: [status('done')] }])
  const r = await make(dead).s.send('wake')
  assert.equal(r.failure?.kind, 'transport')
  assert.equal(dead.agentRequests.length, 3)
})

test('a 429 is not retried and puts the agent into the daemon rate-limit cooldown', async () => {
  const script = scripted([new ResponsesError('OpenAI rate limited (HTTP 429): slow down', 'rate-limit', 429), { calls: [status('done')] }])
  const r = await make(script).s.send('wake')
  assert.equal(script.agentRequests.length, 1)
  assert.equal(r.failure?.kind, 'rate-limit')
  // The daemon decides the pause from the turn's error text.
  assert.equal(classifyTurnOutcome(r.error), 'rate-limited')
  const now = 1_000_000
  const until = backoffUntilFor('rate-limited', now)
  assert.ok(until !== null && until > now)
})

// ── persistence and resume ────────────────────────────────────────────────

async function freshDir(name: string): Promise<string> {
  return realpath(await mkdtemp(join(root, `${name}-`)))
}

test('a restarted session resumes from history.jsonl with its context intact', async () => {
  const dir = await freshDir('resume')
  const first = make(scripted([{ calls: [cli('reply', 'c1', 'noted')] }, { calls: [status('done')] }]), { historyDir: dir })
  await first.s.send('remember the code word: PELICAN')
  await first.s.stop()

  const file = join(dir, HISTORY_FILE)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)

  const script = scripted([{ calls: [status('done')] }])
  const second = make(script, { historyDir: dir, resumeSessionId: first.s.sessionId })
  assert.equal(second.s.sessionId, first.s.sessionId)
  assert.ok(second.logs.some((l) => /resumed session/.test(l)))
  const r = await second.s.send('what was the code word?')
  assert.equal(r.exitCode, 0)
  assert.equal(r.sessionId, first.s.sessionId)
  const sent = textOf(script.agentRequests[0].input)
  assert.match(sent, /PELICAN/)
  assert.match(sent, /noted/)
  assert.match(sent, /what was the code word/)
})

test('a resume that cannot be read starts a fresh session with a new id', async () => {
  const cases: Array<[string, (dir: string) => Promise<void>]> = [
    ['missing', async () => {}],
    ['corrupt', async (dir) => {
      await writeFile(join(dir, HISTORY_FILE), '{"format":"cumora-loop-history","version":1,"sessionId":"loop-old"}\n{broken\n{"role":"user","content":"x"}\n')
    }],
    ['other-session', async (dir) => {
      await writeFile(join(dir, HISTORY_FILE), '{"format":"cumora-loop-history","version":1,"sessionId":"loop-someone-else"}\n')
    }],
  ]
  for (const [name, setup] of cases) {
    const dir = await freshDir(name)
    await setup(dir)
    const script = scripted([{ calls: [status('done')] }])
    const { s, logs } = make(script, { historyDir: dir, resumeSessionId: 'loop-old' })
    assert.notEqual(s.sessionId, 'loop-old', name)
    assert.ok(logs.some((l) => /starting a fresh session/.test(l)), name)
    const r = await s.send('hello')
    assert.equal(r.sessionId, s.sessionId, name)
    assert.equal(script.agentRequests[0].input.length, 1, name)
    // The fresh session now owns the file.
    const reloaded = loadHistory(dir, s.sessionId)
    assert.ok(reloaded.ok, name)
  }
})

test('a torn last line is tolerated, and an orphaned call is dropped on load', async () => {
  const dir = await freshDir('torn')
  const lines = [
    { format: 'cumora-loop-history', version: 1, sessionId: 'loop-a' },
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'function_call', call_id: 'k1', name: 'set_turn_status', arguments: '{}' },
  ].map((l) => JSON.stringify(l)).join('\n')
  await writeFile(join(dir, HISTORY_FILE), `${lines}\n{"type":"function_call_out`)
  const loaded = loadHistory(dir, 'loop-a')
  assert.ok(loaded.ok)
  if (!loaded.ok) return
  assert.equal(loaded.items.length, 1)
  assert.equal(loaded.repaired, 1)
})

test('compaction rewrites the history file, so a resume sees the compacted context', async () => {
  const dir = await freshDir('rewrite')
  const script = scripted([{ calls: [status('done')] }, { calls: [status('done')] }], ['MEMO-OF-EARLIER'])
  const { s } = make(script, { historyDir: dir })
  await s.send(`first ${'lorem ipsum '.repeat(55_000)}`)
  await s.send('second')
  await s.stop()
  const raw = await readFile(join(dir, HISTORY_FILE), 'utf8')
  assert.match(raw, /MEMO-OF-EARLIER/)
  assert.doesNotMatch(raw, /lorem ipsum lorem ipsum/)
  const loaded = loadHistory(dir, s.sessionId)
  assert.ok(loaded.ok && loaded.items.length === s.historyLength)
})
