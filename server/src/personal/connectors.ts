/**
 * Connector storage for personal mode (docs/personal-bot/mvp-backend-design.md
 * §4.1, §12). Every query is scoped by company_id. Writes enqueue
 * `connector.changed` in the same transaction (realtime outbox), so a client
 * never sees an event for a row that did not commit.
 *
 * The server owns policy: `brokerScope` is what a bot may see and
 * `authorizeConnectorCall` is the check the daemon must pass before every
 * call. A denial is audited here, on the authoritative side, so a daemon that
 * skipped its own reporting still leaves a trace.
 */
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'
import type { PoolClient } from 'pg'
import type { ConnectorDefinition, Effect, HttpMethod } from '../broker/definition.js'
import { SAFE_METHODS, splitActionName } from '../broker/definition.js'
import { pool } from '../db/pool.js'
import { findIdempotentCreate, requestHash } from '../idempotent-create.js'
import { enqueueBroadcast, withOutboxTransaction } from '../realtime-outbox.js'
import { CH_CONNECTORS } from '../redis.js'
import { parseConnectorYaml, type ParseOptions } from './connector-schema.js'

export type ConnectorStatus = 'draft' | 'active' | 'disabled'

export interface ConnectorActionDto {
  id: string
  effect: Effect
  effectConfirmed: boolean
  method: string | null
  paramsSchema: Record<string, unknown>
  description: string | null
}

export interface ConnectorDto {
  id: string
  slug: string
  kind: 'http' | 'mcp' | 'builtin'
  status: ConnectorStatus
  name: string | null
  description: string | null
  baseUrl: string | null
  adhocRead: boolean
  createdByKind: 'user' | 'bot'
  createdAt: string
  updatedAt: string
  actions: ConnectorActionDto[]
}

export interface ConnectorCredentialDto {
  /** The name the definition's `auth.credential` refers to. */
  name: string
  /** When the daemon last stored it, or null when it is not set yet. */
  updatedAt: string | null
}

export interface ConnectorDetailDto extends ConnectorDto {
  definitionYaml: string
  /** The credentials this connector needs and whether each is set. Values
   *  never leave the daemon's vault; the server only knows names. */
  credentials: ConnectorCredentialDto[]
}

interface ConnectorRow {
  id: string
  slug: string
  kind: ConnectorDto['kind']
  status: ConnectorStatus
  definition: ConnectorDefinition
  definition_yaml: string
  adhoc_read: boolean
  created_by_kind: 'user' | 'bot'
  created_at: Date
  updated_at: Date
}

interface ActionRow {
  connector_id: string
  action_id: string
  effect: Effect
  effect_confirmed: boolean
  http_method: string | null
  params_schema: Record<string, unknown>
  description: string | null
}

const CONNECTOR_COLUMNS = 'id, slug, kind, status, definition, definition_yaml, adhoc_read, created_by_kind, created_at, updated_at'

function toDto(row: ConnectorRow, actions: ActionRow[]): ConnectorDto {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    name: row.definition.name ?? null,
    description: row.definition.description ?? null,
    baseUrl: row.definition.baseUrl ?? null,
    adhocRead: row.adhoc_read,
    createdByKind: row.created_by_kind,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    actions: actions
      .filter((a) => a.connector_id === row.id)
      .map((a) => ({
        id: a.action_id,
        effect: a.effect,
        effectConfirmed: a.effect_confirmed,
        method: a.http_method,
        paramsSchema: a.params_schema,
        description: a.description,
      })),
  }
}

async function loadActions(db: Pick<PoolClient, 'query'>, connectorIds: string[]): Promise<ActionRow[]> {
  if (connectorIds.length === 0) return []
  const { rows } = await db.query<ActionRow>(
    `SELECT connector_id, action_id, effect, effect_confirmed, http_method, params_schema, description
       FROM connector_actions WHERE connector_id = ANY($1::text[]) ORDER BY connector_id, action_id`,
    [connectorIds],
  )
  return rows
}

export async function listConnectors(companyId: string): Promise<ConnectorDto[]> {
  const { rows } = await pool.query<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE company_id = $1 ORDER BY created_at, id`,
    [companyId],
  )
  const actions = await loadActions(pool, rows.map((r) => r.id))
  return rows.map((r) => toDto(r, actions))
}

export async function getConnector(companyId: string, id: string): Promise<ConnectorDetailDto | null> {
  const { rows } = await pool.query<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  )
  if (!rows[0]) return null
  const stored = await pool.query<{ name: string; updated_at: Date }>(
    `SELECT name, updated_at FROM connector_credentials WHERE connector_id = $1`,
    [id],
  )
  const needed = rows[0].definition.auth ? [rows[0].definition.auth.credential] : []
  const credentials = needed.map((name) => {
    const hit = stored.rows.find((r) => r.name === name)
    return { name, updatedAt: hit ? hit.updated_at.toISOString() : null }
  })
  return { ...toDto(rows[0], await loadActions(pool, [id])), definitionYaml: rows[0].definition_yaml, credentials }
}

// ── credentials (names only; values live in the daemon's vault) ────────

/** The computer that hosts this workspace's bots, with its vault key. In
 *  personal mode there is exactly one. */
export async function workspaceVaultHost(companyId: string): Promise<{
  computerId: string; online: boolean; publicKey: Record<string, unknown> | null
} | null> {
  const { rows } = await pool.query<{ id: string; status: string; vault_public_key: Record<string, unknown> | null }>(
    `SELECT id, status, vault_public_key FROM computers
      WHERE company_id = $1 AND revoked_at IS NULL AND kind <> 'cloud'
      ORDER BY paired_at NULLS LAST, created_at LIMIT 1`,
    [companyId],
  )
  const r = rows[0]
  return r ? { computerId: r.id, online: r.status === 'online' || r.status === 'busy', publicKey: r.vault_public_key } : null
}

/** The connector a credential belongs to, if the definition really asks for it. */
export async function connectorCredentialTarget(companyId: string, connectorId: string, name: string): Promise<{ slug: string } | null> {
  const { rows } = await pool.query<{ slug: string; definition: ConnectorDefinition }>(
    `SELECT slug, definition FROM connectors WHERE company_id = $1 AND id = $2`,
    [companyId, connectorId],
  )
  const r = rows[0]
  if (!r || r.definition.auth?.credential !== name) return null
  return { slug: r.slug }
}

export async function recordCredential(companyId: string, connectorId: string, name: string, updatedAt: string | null): Promise<void> {
  await withOutboxTransaction(async (client) => {
    if (updatedAt) {
      await client.query(
        `INSERT INTO connector_credentials (connector_id, name, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (connector_id, name) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [connectorId, name, updatedAt],
      )
    } else {
      await client.query(`DELETE FROM connector_credentials WHERE connector_id = $1 AND name = $2`, [connectorId, name])
    }
    await enqueueBroadcast(client, CH_CONNECTORS, {
      type: 'connector.changed', kind: 'connector.updated', companyId, connectorId,
    })
  })
}

/** Replace the workspace's credential bookkeeping with what the daemon's
 *  vault actually holds (`vault set` on the host, or a daemon restart).
 *  Entries for connectors this workspace does not have are ignored. */
export async function syncVaultInventory(companyId: string, entries: Array<{ connector: string; name: string; updatedAt: string }>): Promise<number> {
  return withOutboxTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; slug: string }>(`SELECT id, slug FROM connectors WHERE company_id = $1`, [companyId])
    const bySlug = new Map(rows.map((r) => [r.slug, r.id]))
    await client.query(`DELETE FROM connector_credentials WHERE connector_id = ANY($1::text[])`, [rows.map((r) => r.id)])
    let kept = 0
    for (const e of entries) {
      const id = bySlug.get(e.connector)
      if (!id) continue
      await client.query(
        `INSERT INTO connector_credentials (connector_id, name, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (connector_id, name) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [id, e.name, e.updatedAt],
      )
      kept++
    }
    for (const r of rows) {
      await enqueueBroadcast(client, CH_CONNECTORS, { type: 'connector.changed', kind: 'connector.updated', companyId, connectorId: r.id })
    }
    return kept
  })
}

export class ConnectorConflictError extends Error {
  readonly status = 409
}

/** Thrown for a request that is understood but not allowed (400). */
export class ConnectorRuleError extends Error {
  readonly status = 400
}

/** Create a draft connector from YAML. Throws ConnectorSchemaError (400) on
 *  an invalid definition and ConnectorConflictError (409) on a taken slug.
 *
 *  `effectsConfirmed`: whether a person chose each action's read/write
 *  marking. True for YAML the user wrote; false for an OpenAPI import (every
 *  action generated as write) and for a bot's draft. Unconfirmed markings
 *  must be reviewed before the connector can be enabled. A bot may only
 *  propose write actions: deciding that something is safe to read freely is
 *  the user's call. */
export async function createConnector(args: {
  companyId: string
  actorId: string
  actorKind: 'user' | 'bot'
  yaml: string
  adhocRead: boolean
  requestId: string | null
  effectsConfirmed?: boolean
  parse?: ParseOptions
}): Promise<{ connector: ConnectorDetailDto; replayed: boolean }> {
  const def = parseConnectorYaml(args.yaml, args.parse)
  if (args.actorKind === 'bot') {
    const reads = def.actions.filter((a) => a.effect === 'read').map((a) => a.id)
    if (reads.length) throw new ConnectorRuleError(`a bot draft must mark every action effect: write; the user downgrades reads (${reads.join(', ')})`)
    if (args.adhocRead) throw new ConnectorRuleError('a bot draft cannot open the connector to ad-hoc tasks')
  }
  const confirmed = args.actorKind === 'user' && args.effectsConfirmed !== false
  const hash = requestHash({ yaml: args.yaml, adhocRead: args.adhocRead })
  const result = await withOutboxTransaction(async (client) => {
    const replay = await findIdempotentCreate(client, {
      domain: 'connector', companyId: args.companyId, actorId: args.actorId, requestId: args.requestId, requestHash: hash,
    })
    if (replay) return { id: replay.id, replayed: true }
    const taken = await client.query(`SELECT 1 FROM connectors WHERE company_id = $1 AND slug = $2`, [args.companyId, def.slug])
    if (taken.rowCount) throw new ConnectorConflictError(`a connector with id "${def.slug}" already exists`)
    const id = `con_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    await client.query(
      `INSERT INTO connectors
         (id, company_id, slug, kind, status, definition_yaml, definition, adhoc_read,
          created_by_kind, created_by, creation_request_id, creation_request_hash)
       VALUES ($1, $2, $3, 'http', 'draft', $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [id, args.companyId, def.slug, args.yaml, JSON.stringify(def), args.adhocRead,
        args.actorKind, args.actorId, args.requestId, args.requestId ? hash : null],
    )
    for (const a of def.actions) {
      await client.query(
        `INSERT INTO connector_actions (connector_id, action_id, effect, effect_confirmed, http_method, params_schema, description)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [id, a.id, a.effect, confirmed, a.method, JSON.stringify(a.params), a.description ?? null],
      )
    }
    await enqueueBroadcast(client, CH_CONNECTORS, {
      type: 'connector.changed', kind: 'connector.created', companyId: args.companyId, connectorId: id,
    })
    return { id, replayed: false }
  })
  const connector = await getConnector(args.companyId, result.id)
  if (!connector) throw new Error('connector vanished after create')
  return { connector, replayed: result.replayed }
}

/** Change a connector's status or ad-hoc read flag. Null when not found. */
export async function updateConnector(args: {
  companyId: string
  id: string
  status?: ConnectorStatus
  adhocRead?: boolean
}): Promise<ConnectorDetailDto | null> {
  const found = await withOutboxTransaction(async (client) => {
    if (args.status === 'active') {
      const { rows } = await client.query<{ action_id: string }>(
        `SELECT a.action_id FROM connector_actions a JOIN connectors c ON c.id = a.connector_id
          WHERE c.company_id = $1 AND c.id = $2 AND NOT a.effect_confirmed ORDER BY a.action_id`,
        [args.companyId, args.id],
      )
      if (rows.length) {
        throw new ConnectorRuleError(`confirm the read/write marking of every action before enabling (unconfirmed: ${rows.map((r) => r.action_id).join(', ')})`)
      }
    }
    const { rowCount } = await client.query(
      `UPDATE connectors
          SET status = COALESCE($3, status),
              adhoc_read = COALESCE($4, adhoc_read),
              updated_at = now()
        WHERE company_id = $1 AND id = $2`,
      [args.companyId, args.id, args.status ?? null, args.adhocRead ?? null],
    )
    if (!rowCount) return false
    await enqueueBroadcast(client, CH_CONNECTORS, {
      type: 'connector.changed', kind: 'connector.updated', companyId: args.companyId, connectorId: args.id,
    })
    return true
  })
  return found ? getConnector(args.companyId, args.id) : null
}

/** Rewrite one action's effect inside the stored YAML, keeping the text,
 *  the parsed definition and connector_actions in agreement. */
function withEffect(source: string, actionId: string, effect: Effect): string {
  const doc = yaml.load(source, { schema: yaml.JSON_SCHEMA }) as { actions?: Array<Record<string, unknown>> }
  const action = doc.actions?.find((a) => a?.id === actionId)
  if (!action) throw new Error(`action ${actionId} is missing from the stored definition`)
  action.effect = effect
  return yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' })
}

/** Set one action's read/write marking; the user's choice is the confirmed
 *  one. A GET/HEAD action may be either; any other method stays write.
 *  Null when the connector or action does not exist. */
export async function updateConnectorAction(args: {
  companyId: string
  id: string
  actionId: string
  effect: Effect
  parse?: ParseOptions
}): Promise<ConnectorDetailDto | null> {
  const found = await withOutboxTransaction(async (client) => {
    const { rows } = await client.query<{ definition_yaml: string; http_method: string | null }>(
      `SELECT c.definition_yaml, a.http_method FROM connectors c
         JOIN connector_actions a ON a.connector_id = c.id AND a.action_id = $3
        WHERE c.company_id = $1 AND c.id = $2 FOR UPDATE OF c`,
      [args.companyId, args.id, args.actionId],
    )
    const row = rows[0]
    if (!row) return false
    if (args.effect === 'read' && !SAFE_METHODS.includes((row.http_method ?? '') as HttpMethod)) {
      throw new ConnectorRuleError(`a ${row.http_method} action changes something on the other side and cannot be marked read`)
    }
    const source = withEffect(row.definition_yaml, args.actionId, args.effect)
    const def = parseConnectorYaml(source, args.parse)
    await client.query(
      `UPDATE connectors SET definition_yaml = $3, definition = $4::jsonb, updated_at = now() WHERE company_id = $1 AND id = $2`,
      [args.companyId, args.id, source, JSON.stringify(def)],
    )
    await client.query(
      `UPDATE connector_actions SET effect = $3, effect_confirmed = true WHERE connector_id = $1 AND action_id = $2`,
      [args.id, args.actionId, args.effect],
    )
    await enqueueBroadcast(client, CH_CONNECTORS, {
      type: 'connector.changed', kind: 'connector.updated', companyId: args.companyId, connectorId: args.id,
    })
    return true
  })
  return found ? getConnector(args.companyId, args.id) : null
}

/** Accept the current read/write marking of every action (wizard step 2). */
export async function confirmConnectorActions(companyId: string, id: string): Promise<ConnectorDetailDto | null> {
  const found = await withOutboxTransaction(async (client) => {
    const owned = await client.query(`SELECT 1 FROM connectors WHERE company_id = $1 AND id = $2`, [companyId, id])
    if (!owned.rowCount) return false
    await client.query(`UPDATE connector_actions SET effect_confirmed = true WHERE connector_id = $1`, [id])
    await client.query(`UPDATE connectors SET updated_at = now() WHERE id = $1`, [id])
    await enqueueBroadcast(client, CH_CONNECTORS, { type: 'connector.changed', kind: 'connector.updated', companyId, connectorId: id })
    return true
  })
  return found ? getConnector(companyId, id) : null
}

/** What a console test call sends to the daemon: the stored definition cut
 *  down to the one action. Only read actions on GET/HEAD can be tried, in
 *  any status (testing a draft before enabling it is the point). */
export async function connectorTestTarget(companyId: string, id: string, actionId: string): Promise<
  { ok: true; definition: ConnectorDefinition } | { ok: false; status: 404 | 400; error: string }
> {
  const { rows } = await pool.query<{ definition: ConnectorDefinition; effect: Effect | null }>(
    `SELECT c.definition, a.effect FROM connectors c
       LEFT JOIN connector_actions a ON a.connector_id = c.id AND a.action_id = $3
      WHERE c.company_id = $1 AND c.id = $2`,
    [companyId, id, actionId],
  )
  const row = rows[0]
  if (!row) return { ok: false, status: 404, error: 'connector not found' }
  const action = row.definition.actions.find((a) => a.id === actionId)
  if (!row.effect || !action) return { ok: false, status: 404, error: `the connector has no action ${actionId}` }
  if (row.effect !== 'read' || action.effect !== 'read' || !SAFE_METHODS.includes(action.method)) {
    return { ok: false, status: 400, error: 'only read actions can be tried from the console' }
  }
  return { ok: true, definition: { ...row.definition, actions: [action] } }
}

// ── broker (runtime) ────────────────────────────────────────────────────

export interface ScopeAction {
  name: string
  effect: Effect
  description: string | null
  paramsSchema: Record<string, unknown>
}

export interface ScopeConnector {
  slug: string
  name: string | null
  description: string | null
  definition: ConnectorDefinition
  actions: ScopeAction[]
}

/** What an ad-hoc task (no capability run) may call: read actions of active
 *  connectors the user opened with "临时任务可读". Capability scopes (T14)
 *  widen this per run. */
export async function brokerScope(companyId: string): Promise<ScopeConnector[]> {
  const { rows } = await pool.query<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS} FROM connectors
      WHERE company_id = $1 AND status = 'active' AND adhoc_read = true
      ORDER BY slug`,
    [companyId],
  )
  const actions = await loadActions(pool, rows.map((r) => r.id))
  return rows.map((r) => ({
    slug: r.slug,
    name: r.definition.name ?? null,
    description: r.definition.description ?? null,
    definition: { ...r.definition, actions: r.definition.actions.filter((a) => actions.some((x) => x.connector_id === r.id && x.action_id === a.id && x.effect === 'read')) },
    actions: actions
      .filter((a) => a.connector_id === r.id && a.effect === 'read')
      .map((a) => ({ name: `${r.slug}.${a.action_id}`, effect: a.effect, description: a.description, paramsSchema: a.params_schema })),
  })).filter((c) => c.actions.length > 0)
}

export type AuthorizeResult =
  | { decision: 'allow'; definition: ConnectorDefinition; effect: Effect }
  | { decision: 'deny'; reason: string }

/** The policy check for one call (§9.1, T08 subset): the action must exist on
 *  an active connector, ad-hoc tasks may only read, and only from connectors
 *  opened for ad-hoc reads. Write actions are denied until approvals (T18). */
export async function authorizeConnectorCall(args: { companyId: string; action: string }): Promise<AuthorizeResult> {
  const name = splitActionName(args.action)
  if (!name) return { decision: 'deny', reason: 'not a <connector>.<action> name' }
  const { rows } = await pool.query<ConnectorRow & { effect: Effect | null }>(
    `SELECT c.id, c.slug, c.kind, c.status, c.definition, c.definition_yaml, c.adhoc_read,
            c.created_by_kind, c.created_at, c.updated_at, a.effect
       FROM connectors c
       LEFT JOIN connector_actions a ON a.connector_id = c.id AND a.action_id = $3
      WHERE c.company_id = $1 AND c.slug = $2`,
    [args.companyId, name.slug, name.actionId],
  )
  const row = rows[0]
  if (!row) return { decision: 'deny', reason: `no connector named ${name.slug}` }
  if (!row.effect) return { decision: 'deny', reason: `${name.slug} has no action ${name.actionId}` }
  if (row.status !== 'active') return { decision: 'deny', reason: `connector ${name.slug} is ${row.status}` }
  if (row.effect !== 'read') return { decision: 'deny', reason: 'write actions need an approval, which is not available yet' }
  if (!row.adhoc_read) return { decision: 'deny', reason: `connector ${name.slug} is not open to ad-hoc tasks` }
  const action = row.definition.actions.find((a) => a.id === name.actionId)
  if (!action || action.effect !== 'read') return { decision: 'deny', reason: 'action definition does not match its stored effect' }
  return { decision: 'allow', definition: { ...row.definition, actions: [action] }, effect: 'read' }
}
