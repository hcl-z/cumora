import { createHash } from 'node:crypto'

/**
 * Migration 0012: connectors (docs/personal-bot/mvp-backend-design.md §4.1).
 *
 * A connector is a user-approved definition of an external system the bots
 * may reach through the daemon's Broker; `connector_actions` is one row per
 * declared action, the unit that policy, scope and audit refer to. Both are
 * new tables, so the migration is transactional and takes no lock on any
 * existing table beyond the FK checks on companies/computers.
 *
 * `connector_credentials` and the capability/approval tables arrive with the
 * tasks that first use them (T09 onward).
 */
export const CONNECTORS_SQL = `
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  definition_yaml TEXT NOT NULL,
  definition JSONB NOT NULL,
  adhoc_read BOOLEAN NOT NULL DEFAULT false,
  computer_id TEXT,
  created_by_kind TEXT NOT NULL,
  created_by TEXT NOT NULL,
  creation_request_id TEXT,
  creation_request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT connectors_company_fk
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT connectors_computer_fk
    FOREIGN KEY (computer_id) REFERENCES computers(id) ON DELETE SET NULL,
  CONSTRAINT connectors_kind_check CHECK (kind IN ('http', 'mcp', 'builtin')),
  CONSTRAINT connectors_status_check CHECK (status IN ('draft', 'active', 'disabled')),
  CONSTRAINT connectors_created_by_kind_check CHECK (created_by_kind IN ('user', 'bot')),
  CONSTRAINT connectors_company_slug_key UNIQUE (company_id, slug)
);

CREATE TABLE IF NOT EXISTS connector_actions (
  connector_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  effect TEXT NOT NULL,
  effect_confirmed BOOLEAN NOT NULL DEFAULT false,
  http_method TEXT,
  params_schema JSONB NOT NULL,
  description TEXT,
  CONSTRAINT connector_actions_pkey PRIMARY KEY (connector_id, action_id),
  CONSTRAINT connector_actions_connector_fk
    FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE,
  CONSTRAINT connector_actions_effect_check CHECK (effect IN ('read', 'write'))
);
`

export function connectorsChecksum(): string {
  return createHash('sha256').update(CONNECTORS_SQL).digest('hex')
}
