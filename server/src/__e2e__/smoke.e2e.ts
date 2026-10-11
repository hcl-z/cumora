/**
 * Smoke: the owner @-mentions Chief in 总群 and gets the recorded reply back,
 * through the real server, the real daemon (bootstrap pairing, inbox, loop
 * engine, runtime CLI) and a replayed model.
 *
 * Needs Postgres and Redis (see stack.ts). Without them the test is skipped,
 * unless E2E_REQUIRED=1 (CI), where a missing service is a failure.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { loadCassette } from './fake-openai.js'
import { type Stack, eventually, stackUnavailableReason, startStack } from './stack.js'

interface Conversation { id: string; title: string | null; pinned?: boolean; members?: string[] }
interface Message { id: string; authorId: string; body: string }

const unavailable = await stackUnavailableReason()
if (unavailable && process.env.E2E_REQUIRED === '1') throw new Error(`e2e stack unavailable: ${unavailable}`)

let stack: Stack | null = null

before(async () => {
  if (unavailable) return
  stack = await startStack({ cassette: await loadCassette(join(import.meta.dirname, 'cassettes', 'smoke-allhands.json')) })
})

after(async () => {
  if (!stack) return
  if (process.env.E2E_LOG_DIR) await stack.dumpLogs(join(process.env.E2E_LOG_DIR, 'smoke.log'))
  await stack.stop()
})

test('@Chief in 总群 gets the recorded reply', { skip: unavailable ?? false, timeout: 180_000 }, async () => {
  const s = stack!
  // Onboarding runs on first login; the daemon pairs right after.
  const general = await eventually(async () => {
    const convos = await s.api<Conversation[]>('/conversations')
    return convos.find((c) => c.title === '总群') ?? null
  }, 30_000, '总群 to exist')
  await s.daemon.waitFor(/\[computer\] paired as /, 60_000)

  await s.api(`/conversations/${general.id}/messages`, { method: 'POST', body: { body: '@Chief E2E-PING 在吗？' } })

  const reply = await eventually(async () => {
    const msgs = await s.api<Message[]>(`/conversations/${general.id}/messages`)
    return msgs.find((m) => m.body.includes('E2E-PONG')) ?? null
  }, 120_000, "Chief's reply")

  assert.match(reply.authorId, /^chief-/)
  assert.equal(reply.body, 'E2E-PONG 收到，Chief 在线。')
  assert.deepEqual(s.openai.unmatched.filter((r) => r.kind === 'agent'), [], 'every agent hop was answered from the cassette')
  assert.equal(s.openai.unusedInteractions().length, 0, 'both recorded hops were used')
})
