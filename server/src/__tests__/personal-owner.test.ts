/**
 * Personal mode admits one account. The seat check is the single choke point
 * for OAuth signup, waitlist approval and local login, so these tests pin
 * that it locks before it reads, and that the second sign-in is refused
 * before any user or waitlist row is written.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import type { PoolClient } from 'pg'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'
process.env.PERSONAL_MODE = '1'

const { personalSeatTaken, ensurePersonalOwner } = await import('../personal/owner.js')
const { findOrCreateUserByProfile, SignInError } = await import('../oauth.js')
const { pool } = await import('../db/pool.js')
const { redis, sub } = await import('../redis.js')

after(async () => {
  try { await pool.end() } catch { /* ignore */ }
  redis.disconnect()
  sub.disconnect()
})

type Responder = (sql: string, params: unknown[]) => { rows: unknown[] } | undefined

function fakeClient(respond: Responder): { client: PoolClient; sql: string[] } {
  const sql: string[] = []
  const client = {
    async query(text: string, params: unknown[] = []) {
      const s = String(text).replace(/\s+/g, ' ').trim()
      sql.push(s)
      return respond(s, params) ?? { rows: [] }
    },
    release() {},
  } as unknown as PoolClient
  return { client, sql }
}

test('the seat check takes the advisory lock before reading users', async () => {
  const { client, sql } = fakeClient((s) => (s.startsWith('SELECT 1 FROM users') ? { rows: [{}] } : undefined))
  assert.equal(await personalSeatTaken(client), true)
  assert.match(sql[0], /pg_advisory_xact_lock/)
  assert.match(sql[1], /^SELECT 1 FROM users/)
})

test('an empty deployment has a free seat', async () => {
  const { client } = fakeClient(() => undefined)
  assert.equal(await personalSeatTaken(client), false)
})

test('local login reuses the existing owner without writing', async () => {
  const { client, sql } = fakeClient((s) => {
    if (s.startsWith('SELECT 1 FROM users')) return { rows: [{}] }
    if (s.startsWith('SELECT u.id')) {
      return { rows: [{ id: 'u-owner', email: 'me@example.com', display_name: 'Me', company_id: 'co-1' }] }
    }
    return undefined
  })
  const owner = await ensurePersonalOwner(client, { email: 'owner@personal.local', displayName: 'Owner' })
  assert.deepEqual(owner, { userId: 'u-owner', email: 'me@example.com', displayName: 'Me', companyId: 'co-1' })
  assert.equal(sql.some((s) => s.startsWith('INSERT')), false)
})

test('local login on an empty deployment creates the owner and its workspace', async () => {
  const { client, sql } = fakeClient(() => undefined)
  const owner = await ensurePersonalOwner(client, { email: 'owner@personal.local', displayName: 'Owner' })
  assert.match(owner.userId, /^u-/)
  assert.match(owner.companyId ?? '', /^co-/)
  const inserts = sql.filter((s) => s.startsWith('INSERT')).map((s) => s.split(' ')[2])
  assert.deepEqual(inserts, ['users', 'companies', 'company_members', 'participants'])
})

test('a second OAuth sign-up is refused before any row is written', async () => {
  const { client, sql } = fakeClient((s) => (s.startsWith('SELECT 1 FROM users') ? { rows: [{}] } : undefined))
  const originalConnect = pool.connect
  pool.connect = (async () => client) as unknown as typeof pool.connect
  try {
    await assert.rejects(
      findOrCreateUserByProfile('github', {
        providerId: 'gh-2', email: 'second@example.com', displayName: 'Second', avatarUrl: null,
      }),
      (e: unknown) => e instanceof SignInError && e.message === 'personal_single_user',
    )
  } finally {
    pool.connect = originalConnect
  }
  assert.equal(sql.some((s) => /^INSERT/.test(s)), false)
  assert.ok(sql.includes('ROLLBACK'))
})
