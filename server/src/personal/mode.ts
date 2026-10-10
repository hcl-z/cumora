/**
 * Personal mode — the fork's single-user, single-workspace deployment shape
 * (docs/personal-bot/mvp-backend-design.md §2.3).
 *
 * Opt-in, using the same truthy grammar as the other opt-in flags in env.ts,
 * so an unset or misspelled value leaves upstream multi-tenant behaviour intact.
 */
export function parsePersonalMode(raw: string | undefined): boolean {
  return /^(true|1|yes|on)$/i.test(raw ?? '')
}
