/**
 * Personal-mode first run against a real Postgres: the Chief bot, the 总群
 * group and the owner↔Chief DM are created exactly once, and the bundled
 * daemon's bootstrap pairing lands the Chief on the first computer and then
 * refuses a second one.
 *
 * Run: INTEGRATION_DATABASE_URL=… npm run test:integration
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { onboardPersonal, backfillPersonalOnboarding, GENERAL_GROUP_TITLE } from '../personal/onboard.js'
import { bootstrapPair } from '../personal/bootstrap.js'
import { ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'

const COMPANY = 'co-personal-test'
const OWNER = 'u-owner'

async function seedOwnerWorkspace(): Promise<void> {
  await pool.query(
    `INSERT INTO companies (id, name, slug) VALUES ($1, 'Owner workspace', 'owner-ws')`,
    [COMPANY],
  )
  await seedUserMembership(OWNER, COMPANY)
  await pool.query(`UPDATE companies SET owner_user_id = $2 WHERE id = $1`, [COMPANY, OWNER])
}

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

test('[integration] personal onboarding creates the Chief, 总群 and the DM once', async () => {
  await seedOwnerWorkspace()
  const first = await onboardPersonal(COMPANY)
  const second = await onboardPersonal(COMPANY)
  assert.ok(first)
  assert.equal(first.seeded, true)
  assert.equal(second?.seeded, false)
  assert.equal(second?.chiefId, first.chiefId)

  const agents = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM participants WHERE company_id = $1 AND kind = 'agent'`, [COMPANY],
  )
  assert.deepEqual(agents.rows.map((r) => r.name), ['Chief'])

  const general = await pool.query<{ title: string; pinned: boolean }>(
    `SELECT title, pinned FROM conversations WHERE id = $1`, [first.generalConversationId],
  )
  assert.equal(general.rows[0]?.title, GENERAL_GROUP_TITLE)
  const members = await pool.query<{ participant_id: string }>(
    `SELECT participant_id FROM conversation_members WHERE conversation_id = $1 ORDER BY ordinal`,
    [first.generalConversationId],
  )
  assert.deepEqual(members.rows.map((r) => r.participant_id), [OWNER, first.chiefId])

  const dms = await pool.query(
    `SELECT c.id FROM conversations c
      WHERE c.company_id = $1 AND c.kind = 'direct'
        AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.participant_id = $2)
        AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.participant_id = $3)`,
    [COMPANY, OWNER, first.chiefId],
  )
  assert.equal(dms.rows.length, 1)

  const marks = await pool.query<{ personal_seeded_at: Date | null; all_hands_conversation_id: string | null; starter_seeded_at: Date | null }>(
    `SELECT personal_seeded_at, all_hands_conversation_id, starter_seeded_at FROM companies WHERE id = $1`, [COMPANY],
  )
  assert.ok(marks.rows[0]?.personal_seeded_at)
  assert.equal(marks.rows[0]?.all_hands_conversation_id, first.generalConversationId)
  assert.ok(marks.rows[0]?.starter_seeded_at, 'starter phases are closed so upstream never layers a team on top')
})

test('[integration] concurrent first logins still produce one Chief', async () => {
  await seedOwnerWorkspace()
  await Promise.all([onboardPersonal(COMPANY), onboardPersonal(COMPANY), onboardPersonal(COMPANY)])
  const agents = await pool.query(`SELECT 1 FROM participants WHERE company_id = $1 AND kind = 'agent'`, [COMPANY])
  assert.equal(agents.rows.length, 1)
  const groups = await pool.query(`SELECT 1 FROM conversations WHERE company_id = $1 AND kind = 'group'`, [COMPANY])
  assert.equal(groups.rows.length, 1)
})

test('[integration] the boot backfill finishes an interrupted onboarding', async () => {
  await seedOwnerWorkspace()
  await backfillPersonalOnboarding()
  const r = await pool.query<{ personal_seeded_at: Date | null }>(
    `SELECT personal_seeded_at FROM companies WHERE id = $1`, [COMPANY],
  )
  assert.ok(r.rows[0]?.personal_seeded_at)
})

test('[integration] bootstrap pairing waits for the owner, pairs once, then refuses', async () => {
  const before = await bootstrapPair({ engines: ['claude'] })
  assert.equal(before.status, 'no_owner')

  await seedOwnerWorkspace()
  const paired = await bootstrapPair({ hostName: 'dev-mac', engines: ['claude'] })
  assert.equal(paired.status, 'paired')
  if (paired.status !== 'paired') return
  assert.equal(paired.companyId, COMPANY)
  assert.ok(paired.deviceToken.length > 20)

  const chief = await pool.query<{ computer_id: string | null; engine: string | null }>(
    `SELECT p.computer_id, p.engine FROM participants p
       JOIN companies c ON c.personal_chief_agent_id = p.id
      WHERE c.id = $1`,
    [COMPANY],
  )
  assert.equal(chief.rows[0]?.computer_id, paired.computerId)
  assert.equal(chief.rows[0]?.engine, 'claude')

  const again = await bootstrapPair({ hostName: 'dev-mac', engines: ['claude'] })
  assert.equal(again.status, 'already_paired')
  const computers = await pool.query(`SELECT 1 FROM computers WHERE company_id = $1 AND kind <> 'cloud'`, [COMPANY])
  assert.equal(computers.rows.length, 1)
})
