/**
 * `loop` is the one engine with no binary. Detection must treat it as always
 * installed, and whether it is runnable depends only on the daemon having an
 * OpenAI key — never on PATH or a version probe.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ENGINE_IDS,
  IN_PROCESS_ENGINE_IDS,
  detectEnginesWithStatus,
  evaluateRunnableEngines,
  getAdapter,
  inProcessEngineBlockedReason,
  isInProcessEngine,
  snapshotDetectedEngines,
} from '../agents/computer/engine.js'

test('loop is registered as an in-process engine, last in detection order', () => {
  assert.equal(ENGINE_IDS.at(-1), 'loop')
  assert.deepEqual([...IN_PROCESS_ENGINE_IDS], ['loop'])
  assert.equal(isInProcessEngine('loop'), true)
  assert.equal(isInProcessEngine('claude'), false)
  assert.equal(getAdapter('loop').id, 'loop')
})

test('loop is always detected, with no PATH probe', async () => {
  const { engines } = await detectEnginesWithStatus()
  assert.ok(engines.includes('loop'))
  const [snap] = await snapshotDetectedEngines(['loop'])
  assert.deepEqual(snap, { id: 'loop', bin: '', path: null })
})

test('loop is runnable exactly when the daemon has an OpenAI key', async () => {
  const withKey = await evaluateRunnableEngines(['loop'], { OPENAI_API_KEY: 'sk-test' }, 'darwin')
  assert.deepEqual([...withKey.runnable], ['loop'])
  assert.deepEqual(withKey.blocked, [])

  const without = await evaluateRunnableEngines(['loop'], {}, 'darwin')
  assert.deepEqual([...without.runnable], [])
  assert.equal(without.blocked[0]?.id, 'loop')
  assert.match(without.blocked[0]?.reason ?? '', /OPENAI_API_KEY/)

  // The unsandboxed compatibility path applies the same key rule.
  const compat = await evaluateRunnableEngines(['loop'], { CUMORA_BYOA_ALLOW_UNSANDBOXED: '1' }, 'darwin')
  assert.deepEqual([...compat.runnable], [])
  assert.equal(compat.blocked[0]?.id, 'loop')
})

test('a blank key does not count as configured', () => {
  assert.match(inProcessEngineBlockedReason('loop', { OPENAI_API_KEY: '   ' }) ?? '', /OPENAI_API_KEY/)
  assert.equal(inProcessEngineBlockedReason('loop', { OPENAI_API_KEY: 'sk-x' }), null)
})

test('loop classify reports a missing key instead of calling out', async () => {
  const r = await getAdapter('loop').classify({ cwd: '/tmp', prompt: 'x', env: {}, signal: new AbortController().signal })
  assert.equal(r.text, '')
  assert.match(r.error ?? '', /api key/i)
})
