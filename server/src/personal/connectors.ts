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
import type { PoolClient } from 'pg'
import type { ConnectorDefinition, Effect } from '../broker/definition.js'
import { splitActionName } from '../broker/definition.js'
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

export interface ConnectorDetailDto extends ConnectorDto {
  definitionYaml: string
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
  return { ...toDto(rows[0], await loadActions(pool, [id])), definitionYaml: rows[0].definition_yaml }
}

export class ConnectorConflictError extends Error {
  readonly status = 409
}

/** Create a draft connector from YAML. Throws ConnectorSchemaError (400) on
 *  an invalid definition and ConnectorConflictError (409) on a taken slug. */
export async function createConnector(args: {
  companyId: string
  actorId: string
  actorKind: 'user' | 'bot'
  yaml: string
  adhocRead: boolean
  requestId: string | null
  parse?: ParseOptions
}): Promise<{ connector: ConnectorDetailDto; replayed: boolean }> {
  const def = parseConnectorYaml(args.yaml, args.parse)
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
        `INSERT INTO connector_actions (connector_id, action_id, effect, http_method, params_schema, description)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, a.id, a.effect, a.method, JSON.stringify(a.params), a.description ?? null],
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
