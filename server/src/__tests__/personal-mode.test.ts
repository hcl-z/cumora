/**
 * PERSONAL_MODE starts the deployment empty: no demo seed, no placeholder
 * user, no starter team and none of its boot backfills. Each gate returns
 * before touching the database, so any query here means a gate leaked.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'
process.env.PERSONAL_MODE = '1'

const { parsePersonalMode } = await import('../personal/mode.js')
const { env } = await import('../env.js')
const { seedIfEmpty } = await import('../seed.js')
const { onboardStarterAgents, backfillStarterAgents, backfillStarterAvatars } = await import('../onboardCompany.js')
const { pool } = await import('../db/pool.js')
const { redis, sub } = await import('../redis.js')

after(async () => {
  try { await pool.end() } catch { /* ignore */ }
  redis.disconnect()
  sub.disconnect()
})

test('parsePersonalMode accepts the opt-in truthy grammar only', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(parsePersonalMode(on), true, on)
  for (const off of [undefined, '', '0', 'false', 'off', 'no', 'personal', ' 1']) {
    assert.equal(parsePersonalMode(off), false, String(off))
  }
})

test('env exposes PERSONAL_MODE from the process environment', () => {
  assert.equal(env.PERSONAL_MODE, true)
})

test('seed, starter onboarding and starter backfills never query in personal mode', async () => {
  const originalQuery = pool.query.bind(pool)
  const originalConnect = pool.connect
  const queries: string[] = []
  pool.query = (async (sql: string) => {
    queries.push(String(sql))
    return { rows: [] }
  }) as unknown as typeof pool.query
  pool.connect = (async () => {
    queries.push('connect')
    throw new Error('unexpected connect')
  }) as unknown as typeof pool.connect
  try {
    await seedIfEmpty()
    await onboardStarterAgents('c-personal')
    await onboardStarterAgents('c-personal', { computerId: 'computer-1', engine: 'claude' })
    await backfillStarterAgents()
    await backfillStarterAvatars()
  } finally {
    pool.query = originalQuery as typeof pool.query
    pool.connect = originalConnect
  }
  assert.deepEqual(queries, [])
})
