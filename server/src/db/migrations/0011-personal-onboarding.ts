import { createHash } from 'node:crypto'

/**
 * Migration 0011: personal-mode onboarding markers on companies.
 *
 * Personal mode (docs/personal-bot) replaces the starter team with one Chief
 * bot and a "总群" group. `personal_chief_agent_id` records which participant
 * is the Chief, and doubles as "the Chief has been created"; the onboarding
 * is complete only once `personal_seeded_at` is set, so a crash between the
 * two is resumed rather than repeated. Both columns are nullable with no
 * default, so the ALTER is metadata-only.
 */
export const PERSONAL_ONBOARDING_SQL = `
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS personal_chief_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS personal_seeded_at TIMESTAMPTZ;
`

export function personalOnboardingChecksum(): string {
  return createHash('sha256').update(PERSONAL_ONBOARDING_SQL).digest('hex')
}
