/**
 * Personal-mode onboarding (mvp-backend-design §13.1): the Chief bot, the
 * "总群" group with the owner and the Chief, and the owner↔Chief DM.
 *
 * Replaces onboardStarterAgents in personal mode. Idempotent and resumable:
 * the company row lock makes concurrent first logins serialise, the Chief and
 * the group are created together in one transaction, and the DM step is
 * retried until it succeeds because `personal_seeded_at` is only set after it.
 */
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { ensureDirectConversation } from '../agents/private_chat.js'
import { invalidatePersonaCache } from '../agents/personas.js'

export const CHIEF_NAME = 'Chief'
export const GENERAL_GROUP_TITLE = '总群'

const CHIEF_SYSTEM_PROMPT = [
  "You are Chief, the owner's chief of staff in their personal bot workspace.",
  'You take requests in plain language, work out what is needed, and see them through.',
  'Reply in the language the owner writes in. Be brief, concrete and honest about what you can and cannot do yet;',
  'never claim an action you did not take.',
].join(' ')

export interface PersonalOnboarding {
  companyId: string
  chiefId: string
  generalConversationId: string | null
  /** Whether this call did the work, as opposed to finding it already done. */
  seeded: boolean
}

/** The workspace's owner: `owner_user_id`, falling back to the earliest owner
 *  membership for rows created before that column was filled. */
async function ownerOf(client: import('pg').PoolClient, companyId: string): Promise<string | null> {
  const { rows } = await client.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id FROM companies WHERE id = $1`, [companyId],
  )
  if (rows[0]?.owner_user_id) return rows[0].owner_user_id
  const { rows: cm } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM company_members WHERE company_id = $1 AND role = 'owner'
      ORDER BY joined_at ASC LIMIT 1`,
    [companyId],
  )
  return cm[0]?.user_id ?? null
}

export async function onboardPersonal(companyId: string): Promise<PersonalOnboarding | null> {
  const client = await pool.connect()
  let ownerId: string | null = null
  let chiefId: string
  let generalConversationId: string | null
  let created = false
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{
      personal_chief_agent_id: string | null
      personal_seeded_at: Date | null
      all_hands_conversation_id: string | null
    }>(
      `SELECT personal_chief_agent_id, personal_seeded_at, all_hands_conversation_id
         FROM companies WHERE id = $1 FOR UPDATE`,
      [companyId],
    )
    const row = rows[0]
    if (!row) { await client.query('ROLLBACK'); return null }
    if (row.personal_seeded_at && row.personal_chief_agent_id) {
      await client.query('COMMIT')
      return {
        companyId,
        chiefId: row.personal_chief_agent_id,
        generalConversationId: row.all_hands_conversation_id,
        seeded: false,
      }
    }
    ownerId = await ownerOf(client, companyId)
    if (!ownerId) { await client.query('ROLLBACK'); return null }

    if (row.personal_chief_agent_id) {
      chiefId = row.personal_chief_agent_id
      generalConversationId = row.all_hands_conversation_id
    } else {
      // Participant ids are global (runtime JWTs address agents by id alone),
      // so the Chief gets a random suffix rather than a bare "chief".
      chiefId = `chief-${randomUUID().slice(0, 8)}`
      await client.query(
        `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, status, bio, tools,
                                   system_prompt, company_id)
         VALUES ($1, 'agent', $2, $3, 'C', $4, 'avail', $5, $6::jsonb, $7, $8)`,
        [
          chiefId, CHIEF_NAME, '幕僚长', 'linear-gradient(135deg, #3FB6A8, #1F7A70)',
          'Your chief of staff. Tell me what you need and I will get it done or tell you what is missing.',
          JSON.stringify(['bash']), CHIEF_SYSTEM_PROMPT, companyId,
        ],
      )
      // The general group is the workspace's all-hands: future bots and
      // humans auto-join it through joinAllHands like any other workspace.
      generalConversationId = `allhands-${randomUUID().slice(0, 10)}`
      const members = [ownerId, chiefId]
      await client.query(
        `INSERT INTO conversations (id, kind, title, subtitle, members, pinned, tag, company_id)
         VALUES ($1, 'group', $2, $3, $4::jsonb, TRUE, 'team', $5)`,
        [generalConversationId, GENERAL_GROUP_TITLE, `team · ${members.length}`, JSON.stringify(members), companyId],
      )
      await client.query(
        `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, 1)
         ON CONFLICT (conversation_id) DO NOTHING`,
        [generalConversationId],
      )
      // Marking the starter phases done keeps upstream onboarding from ever
      // layering a second all-hands or starter team on this workspace.
      await client.query(
        `UPDATE companies
            SET personal_chief_agent_id = $2,
                all_hands_conversation_id = $3,
                all_hands_seeded_at = COALESCE(all_hands_seeded_at, NOW()),
                starter_seeded_at = COALESCE(starter_seeded_at, NOW()),
                starter_dms_seeded_at = COALESCE(starter_dms_seeded_at, NOW())
          WHERE id = $1`,
        [companyId, chiefId, generalConversationId],
      )
      created = true
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  if (created) invalidatePersonaCache()

  await ensureDirectConversation({ companyId, firstId: ownerId, secondId: chiefId })
  await pool.query(
    `UPDATE companies SET personal_seeded_at = COALESCE(personal_seeded_at, NOW()) WHERE id = $1`,
    [companyId],
  )
  return { companyId, chiefId, generalConversationId, seeded: true }
}

/** Boot-time catch-up for a workspace whose owner signed in while onboarding
 *  failed or before this code shipped. Personal mode has one workspace, so
 *  this is at most one row. */
export async function backfillPersonalOnboarding(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT c.id FROM companies c
      WHERE c.personal_seeded_at IS NULL
        AND (c.owner_user_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = c.id AND m.role = 'owner'))`,
  )
  for (const { id } of rows) {
    try { await onboardPersonal(id) }
    catch (e) { console.warn(`[personal] onboarding backfill failed for ${id}`, e) }
  }
}
