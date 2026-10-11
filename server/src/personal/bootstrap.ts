/**
 * Bootstrap pairing (mvp-backend-design §13.1): the daemon that ships with a
 * personal deployment pairs itself with a shared secret, so the owner never
 * copies a pairing code by hand.
 *
 * The secret is only good for the FIRST computer. Once the workspace has a
 * live paired computer the endpoint answers 410, and re-pairing goes through
 * the normal reconnect code like any other Cumora computer.
 */
import { pool } from '../db/pool.js'
import { issuePairingCode, pairComputer } from '../agents/computer/registry.js'
import { invalidatePersonaCache } from '../agents/personas.js'
import { onboardPersonal } from './onboard.js'

const BOOTSTRAP_PAIR_LOCK_KEY = 7_643_178_926_802n

export type BootstrapPairResult =
  | { status: 'paired'; computerId: string; companyId: string; deviceToken: string }
  | { status: 'no_owner' }
  | { status: 'already_paired' }
  | { status: 'invalid' }

export async function bootstrapPair(args: {
  hostName?: string
  engines: string[]
  detected?: unknown
  blocked?: string[]
  version?: string
  supervised?: boolean
}): Promise<BootstrapPairResult> {
  // A session-level lock on a dedicated connection: two daemons racing the
  // first pairing must not both pass the "already paired" check.
  const lockClient = await pool.connect()
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [BOOTSTRAP_PAIR_LOCK_KEY])
    try {
      const { rows: owners } = await pool.query<{ company_id: string; user_id: string }>(
        `SELECT m.company_id, m.user_id
           FROM company_members m
          WHERE m.role = 'owner'
          ORDER BY m.joined_at ASC
          LIMIT 1`,
      )
      const owner = owners[0]
      if (!owner) return { status: 'no_owner' }
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM computers
          WHERE company_id = $1 AND kind <> 'cloud' AND revoked_at IS NULL
          LIMIT 1`,
        [owner.company_id],
      )
      if (existing.length > 0) return { status: 'already_paired' }

      const { code } = await issuePairingCode({ companyId: owner.company_id, ownerUserId: owner.user_id })
      const paired = await pairComputer({
        code,
        hostName: args.hostName,
        engines: args.engines,
        detected: args.detected,
        blocked: args.blocked,
        version: args.version,
        supervised: args.supervised,
        deferBroadcast: true,
      })
      if (!paired) return { status: 'invalid' }

      // Make sure the Chief exists before it is placed on this computer, in
      // case onboarding failed at sign-in.
      await onboardPersonal(paired.companyId)
      // The computer's first engine is its default, the same rule the free-tier
      // pairing path uses; agents that already live on a real computer keep it.
      const engine = args.engines[0] ?? 'claude'
      await pool.query(
        `UPDATE participants p
            SET computer_id = $1, engine = COALESCE(NULLIF(p.engine, 'managed'), $2)
          WHERE p.company_id = $3 AND p.kind = 'agent' AND p.departed_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM computers c
               WHERE c.id = p.computer_id AND c.kind <> 'cloud' AND c.revoked_at IS NULL
            )`,
        [paired.computerId, engine, paired.companyId],
      )
      invalidatePersonaCache()
      return { status: 'paired', ...paired }
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [BOOTSTRAP_PAIR_LOCK_KEY]).catch(() => {})
    }
  } finally {
    lockClient.release()
  }
}
