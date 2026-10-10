/**
 * The single account a personal deployment admits (mvp-backend-design §2.3).
 *
 * Every path that mints a `users` row — OAuth signup, waitlist approval and
 * local login — goes through `claimPersonalSeat` first, so "only the first
 * user may register" is enforced in one place rather than per caller.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { insertPersonalWorkspace } from '../personal-workspace.js'

/** Serialises seat checks across concurrent first sign-ins. Transaction-scoped,
 *  so it is released on COMMIT/ROLLBACK with no unlock to forget. */
const PERSONAL_SEAT_LOCK_KEY = 7_643_178_926_801n

/** True when the deployment already has its one account. Takes the seat lock
 *  first, so a caller that then inserts cannot race another first sign-in.
 *  Must run inside an open transaction. */
export async function personalSeatTaken(client: PoolClient): Promise<boolean> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [PERSONAL_SEAT_LOCK_KEY])
  const { rows } = await client.query('SELECT 1 FROM users LIMIT 1')
  return rows.length > 0
}

export interface PersonalOwner {
  userId: string
  email: string
  displayName: string
  companyId: string | null
}

/** Find the deployment's owner, or create the account and its workspace on
 *  first login. Mirrors oauth.ts Path C minus the provider identity: there
 *  is no external account to link. Must run inside an open transaction. */
export async function ensurePersonalOwner(
  client: PoolClient,
  args: { email: string; displayName: string },
): Promise<PersonalOwner> {
  if (await personalSeatTaken(client)) {
    const { rows } = await client.query<{ id: string; email: string; display_name: string; company_id: string | null }>(
      `SELECT u.id, u.email, u.display_name,
              (SELECT m.company_id FROM company_members m
                WHERE m.user_id = u.id ORDER BY m.company_id LIMIT 1) AS company_id
         FROM users u
        ORDER BY u.created_at, u.id
        LIMIT 1`,
    )
    const u = rows[0]
    return { userId: u.id, email: u.email, displayName: u.display_name, companyId: u.company_id }
  }

  const userId = `u-${randomUUID().slice(0, 12)}`
  await client.query(
    `INSERT INTO users (id, email, display_name, password_hash, is_admin)
       VALUES ($1, $2, $3, NULL, false)`,
    [userId, args.email, args.displayName],
  )
  const companyId = `co-${randomUUID().slice(0, 10)}`
  await insertPersonalWorkspace(client, {
    companyId,
    name: `${args.displayName}'s workspace`,
    ownerUserId: userId,
    email: args.email,
  })
  await client.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [companyId, userId],
  )
  await client.query(
    `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, status, company_id)
       VALUES ($1, 'human', $2, NULL, $3, '#FF8870', 'avail', $4)
       ON CONFLICT (id, company_id) DO NOTHING`,
    [userId, args.displayName, args.displayName.charAt(0).toUpperCase(), companyId],
  )
  return { userId, email: args.email, displayName: args.displayName, companyId }
}
