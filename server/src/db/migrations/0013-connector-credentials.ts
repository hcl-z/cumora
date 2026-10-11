import { createHash } from 'node:crypto'

/**
 * Migration 0013: credential vault bookkeeping (docs/personal-bot/
 * mvp-backend-design.md §4.1, §4.2, §7).
 *
 * The server never holds a credential value. It stores the daemon's ECDH
 * public key, which browsers seal credentials to, and the name and time of
 * each credential the daemon reports having. Adding a nullable column with
 * no default is metadata-only; the new table is new, so the whole migration
 * runs in one transaction.
 */
export const CONNECTOR_CREDENTIALS_SQL = `
ALTER TABLE computers ADD COLUMN IF NOT EXISTS vault_public_key JSONB;

CREATE TABLE IF NOT EXISTS connector_credentials (
  connector_id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT connector_credentials_pkey PRIMARY KEY (connector_id, name),
  CONSTRAINT connector_credentials_connector_fk
    FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
);
`

export function connectorCredentialsChecksum(): string {
  return createHash('sha256').update(CONNECTOR_CREDENTIALS_SQL).digest('hex')
}
