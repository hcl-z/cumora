/**
 * One bot's Broker (docs/personal-bot/mvp-backend-design.md §6): the only way
 * the bot reaches an external system. It lists what the server's scope
 * allows, validates the model's args, asks the server to authorize every
 * call, executes the server-returned definition (never a cached one), numbers
 * each result as evidence and reports a `connector.call` run event.
 *
 * Results go back to the model marked untrusted: they are data to cite as
 * [ev_n], not instructions. Dependency-free for the daemon bundle; the daemon
 * supplies the server round-trips as BrokerDeps.
 */
import { createHash } from 'node:crypto'
import { type ConnectorAction, type ConnectorDefinition, type Effect, splitActionName, validateArgs } from './definition.js'
import { ConnectorCallError, type ExecuteOptions, RateLimiter, executeHttp, type HttpResult } from './http-executor.js'

export interface ScopeAction { name: string; effect: Effect; description: string | null; paramsSchema: Record<string, unknown> }
export interface ScopeConnector { slug: string; name: string | null; description: string | null; definition: ConnectorDefinition; actions: ScopeAction[] }

export type AuthorizeVerdict =
  | { decision: 'allow'; definition: ConnectorDefinition; effect: Effect }
  | { decision: 'deny'; reason: string }

export interface BrokerEvent { kind: string; level: 'info' | 'warn'; title: string; data: Record<string, unknown> }

export interface BrokerDeps {
  fetchScope(): Promise<ScopeConnector[] | null>
  authorize(req: { action: string; argsHash: string; runId: string | null }): Promise<AuthorizeVerdict | null>
  /** Fire-and-forget run event for the current run. */
  recordEvent(event: BrokerEvent): void
  currentRunId(): string | null
  allowLoopbackHttp?: boolean
  /** The vault value for a connector's credential, or null if unset. */
  credential?: (connector: string, name: string) => string | null
  /** Replace every known credential value with `[REDACTED:<name>]`. Applied
   *  to every result, error and run event before it leaves the Broker. */
  redact?: (text: string) => string
  /** Test seam: replaces the real HTTP call. */
  execute?: (def: ConnectorDefinition, action: ConnectorAction, args: Record<string, unknown>, opts: ExecuteOptions) => Promise<HttpResult>
  now?: () => number
}

/** What a loop tool calls. Mirrors ConnectorBroker in computer/engine.ts. */
export interface BrokerToolResult { output: string }

export const SCOPE_TTL_MS = 60_000
/** Budget for `data` inside the result, under the tool layer's 8KB cap so
 *  the JSON envelope itself is never cut. */
export const RESULT_DATA_BYTES = 6_000

export function argsHash(args: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
    return v
  }
  return createHash('sha256').update(JSON.stringify(stable(args ?? {}))).digest('hex')
}

function cutUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return { text, cut: false }
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return { text: buf.subarray(0, end).toString('utf8'), cut: true }
}

export class Broker {
  private scope: { at: number; connectors: ScopeConnector[] } | null = null
  private evidenceCount = 0
  private readonly limiter: RateLimiter
  private readonly now: () => number

  constructor(private readonly deps: BrokerDeps) {
    this.now = deps.now ?? Date.now
    this.limiter = new RateLimiter(this.now)
  }

  /** Evidence ids restart with each turn. */
  beginTurn(): void { this.evidenceCount = 0 }

  /** Drop the cached scope (connector.changed). */
  invalidate(): void { this.scope = null }

  private async connectors(force = false): Promise<ScopeConnector[]> {
    if (!force && this.scope && this.now() - this.scope.at < SCOPE_TTL_MS) return this.scope.connectors
    const fetched = await this.deps.fetchScope()
    if (fetched === null) {
      if (this.scope) return this.scope.connectors
      throw new Error('could not load connector scope from the server')
    }
    this.scope = { at: this.now(), connectors: fetched }
    return fetched
  }

  async list(): Promise<BrokerToolResult> {
    const connectors = await this.connectors()
    if (!connectors.length) return { output: 'No connectors are available to you right now. The user enables them in the console.' }
    return {
      output: JSON.stringify(connectors.map((c) => ({
        connector: c.slug,
        name: c.name,
        description: c.description,
        actions: c.actions.map((a) => ({ action: a.name, effect: a.effect, description: a.description })),
      }))),
    }
  }

  private async findAction(name: string): Promise<ScopeAction | null> {
    const lookup = (cs: ScopeConnector[]) => cs.flatMap((c) => c.actions).find((a) => a.name === name) ?? null
    return lookup(await this.connectors()) ?? lookup(await this.connectors(true))
  }

  async describe(action: string): Promise<BrokerToolResult> {
    const found = await this.findAction(action)
    if (!found) return { output: `error: no action ${action} in your scope; call connector_list` }
    return { output: JSON.stringify({ action: found.name, effect: found.effect, description: found.description, params: found.paramsSchema }) }
  }

  async call(action: string, rawArgs: unknown): Promise<BrokerToolResult> {
    const name = splitActionName(action)
    if (!name) return { output: 'error: action must be <connector>.<action>; call connector_list' }
    const args = (rawArgs ?? {}) as Record<string, unknown>
    const hash = argsHash(args)
    const runId = this.deps.currentRunId()

    const verdict = await this.deps.authorize({ action, argsHash: hash, runId })
    if (!verdict) return { output: 'error: the server could not authorize this call right now; try again later' }
    if (verdict.decision === 'deny') {
      // The server already audited the denial.
      return { output: `exit 3\nDENIED: ${verdict.reason}` }
    }
    const def = verdict.definition
    const spec = def.actions.find((a) => a.id === name.actionId)
    if (!spec) return { output: `exit 3\nDENIED: ${action} is not in the authorized definition` }
    const problems = validateArgs(spec, args)
    if (problems.length) return { output: `error: invalid args for ${action}: ${problems.join('; ')}` }
    if (!this.limiter.take(def.slug, def.rateLimitPerMinute)) {
      return { output: `error: rate limit for ${def.slug} (${def.rateLimitPerMinute}/min) reached; wait before calling it again` }
    }

    let credential: string | null = null
    if (def.auth) {
      try {
        credential = this.deps.credential?.(def.slug, def.auth.credential) ?? null
      } catch {
        return { output: `error: credential ${def.auth.credential} for ${def.slug} could not be read from this computer's vault` }
      }
      if (!credential) {
        return { output: `error: ${def.slug} needs the credential ${def.auth.credential}, which is not set on this computer. Ask the user to add it in the console.` }
      }
    }

    const execute = this.deps.execute ?? executeHttp
    let result: HttpResult
    try {
      result = await execute(def, spec, args, { allowLoopbackHttp: this.deps.allowLoopbackHttp, credential })
    } catch (err) {
      const message = this.redact(err instanceof Error ? err.message : String(err))
      const reason = err instanceof ConnectorCallError ? err.reason : 'network'
      this.record({
        kind: 'connector.call', level: 'warn', title: `${action} failed`,
        data: { action, effect: spec.effect, argsHash: hash, error: message, reason },
      })
      return { output: `error: ${action} failed (${reason}): ${message}` }
    }

    const evidenceId = `ev_${++this.evidenceCount}`
    const fetchedAt = new Date(this.now()).toISOString()
    // Some APIs echo the key back; nothing past this line sees it.
    const text = this.redact(result.body.toString('utf8'))
    let data: unknown = text
    if (/json/i.test(result.contentType ?? '') || /^[[{]/.test(text.trim())) {
      try { data = JSON.parse(text) } catch { /* keep text */ }
    }
    let serialized = typeof data === 'string' ? data : JSON.stringify(data)
    const { text: kept, cut } = cutUtf8(serialized, RESULT_DATA_BYTES)
    serialized = kept
    this.record({
      kind: 'connector.call', level: result.status >= 400 ? 'warn' : 'info', title: `${action} → ${result.status}`,
      data: {
        action, effect: spec.effect, argsHash: hash, args: cut ? undefined : args,
        status: result.status, durationMs: result.durationMs, bytes: result.body.byteLength, evidenceId,
      },
    })
    return {
      output: this.redact(JSON.stringify({
        evidence_id: evidenceId,
        source: { connector: def.slug, action: spec.id, fetched_at: fetchedAt },
        untrusted: true,
        status: result.status,
        ...(cut ? { truncated: true, data_text: serialized } : { data }),
      })),
    }
  }

  private redact(text: string): string {
    return this.deps.redact ? this.deps.redact(text) : text
  }

  /** Every run event goes through redaction, including the model's args. */
  private record(event: BrokerEvent): void {
    this.deps.recordEvent(JSON.parse(this.redact(JSON.stringify(event))) as BrokerEvent)
  }
}
