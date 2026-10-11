/**
 * One bot's long-lived conversation with the model for the `loop` engine.
 *
 * v0 (task T04): a bounded hop loop with the turn-status protocol, steering
 * at hop boundaries and per-hop usage reports. Compaction, completion
 * verification, retries and on-disk history arrive with v1 (task T05); until
 * then history lives in memory and a daemon restart starts a fresh session.
 */
import { randomUUID } from 'node:crypto'
import type { ResponseInputItem } from 'openai/resources/responses/responses'
import { applyResponseStreamEvent, consumeResponseStream, newResponseStreamState } from '../../turn-stream.js'
import type { EngineHopReport, EngineRunResult, EngineSession, EngineUsage } from '../engine.js'
import { ResponsesError, type ResponsesConfig, type StreamResponses, createResponsesStreamer } from './responses.js'
import { LOOP_TOOL_DEFS, type RuntimeCliInvoker, isTerminalTurnStatus, runTool } from './tools.js'

export const LOOP_MAX_HOPS = 200
const MAX_OUTPUT_TOKENS = 4000
/** Hops that end with no tool call and no status before the turn is failed. */
const STATUS_NUDGE_LIMIT = 2

export interface LoopSessionOptions {
  /** realpath of the agent home. */
  home: string
  model: string
  instructions: string
  config: ResponsesConfig | null
  runtimeCli: RuntimeCliInvoker | null
  onLog: (line: string) => void
  onHopUsage?: (report: EngineHopReport) => void
  /** Injected in tests; defaults to the real Responses API. */
  stream?: StreamResponses
  maxHops?: number
}

/** OpenAI usage → the Claude-style shape the daemon's ledger reads, where
 *  input_tokens is the uncached remainder. */
export function engineUsageFromOpenAI(raw: unknown): EngineUsage {
  const u = (raw ?? {}) as {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  }
  const input = u.input_tokens ?? 0
  const cached = u.input_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: Math.max(0, input - cached),
    cache_read_input_tokens: cached,
    output_tokens: u.output_tokens ?? 0,
  }
}

function addUsage(a: EngineUsage, b: EngineUsage): EngineUsage {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
  }
}

function failure(kind: NonNullable<EngineRunResult['failure']>['kind'], message: string): Pick<EngineRunResult, 'exitCode' | 'error' | 'failure'> {
  return { exitCode: 1, error: message, failure: { kind, message, diagnostic: message } }
}

export class LoopSession implements EngineSession {
  readonly sessionId = `loop-${randomUUID()}`
  readonly carriesStandingPrompt = true
  private history: ResponseInputItem[] = []
  private steerQueue: string[] = []
  private turnAbort: AbortController | null = null
  private stopped = false
  private readonly stream: StreamResponses | null

  constructor(private readonly opts: LoopSessionOptions) {
    this.stream = opts.stream ?? (opts.config ? createResponsesStreamer(opts.config) : null)
  }

  get alive(): boolean { return !this.stopped }

  steer(text: string): void {
    if (this.turnAbort && text.trim()) this.steerQueue.push(text)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.turnAbort?.abort()
  }

  private pushUser(text: string): void {
    this.history.push({ role: 'user', content: [{ type: 'input_text', text }] } as ResponseInputItem)
  }

  async send(prompt: string): Promise<EngineRunResult> {
    const base = { sessionId: this.sessionId, model: this.opts.model }
    if (!this.stream) {
      return { ...base, ...failure('authentication', 'OPENAI_API_KEY is not set for the daemon (api key missing)') }
    }
    const abort = new AbortController()
    this.turnAbort = abort
    this.steerQueue = []
    this.pushUser(prompt)
    let usage: EngineUsage = {}
    let nudges = 0
    try {
      const maxHops = this.opts.maxHops ?? LOOP_MAX_HOPS
      for (let hop = 0; hop < maxHops; hop++) {
        if (this.stopped) return { ...base, usage, ...failure('unknown', 'session stopped') }
        const t0 = Date.now()
        const state = newResponseStreamState()
        await consumeResponseStream(
          this.stream({
            model: this.opts.model,
            instructions: this.opts.instructions,
            input: this.history,
            tools: LOOP_TOOL_DEFS,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            reasoningEffort: 'low',
          }, abort.signal),
          (event) => applyResponseStreamEvent(state, event),
        )
        const hopUsage = engineUsageFromOpenAI(state.responseUsage)
        usage = addUsage(usage, hopUsage)
        const calls = Object.values(state.pendingTools)
        const text = Array.from(state.responseTextByPart.values()).join('\n').trim()
        this.opts.onHopUsage?.({
          model: this.opts.model, usage: hopUsage, latencyMs: Date.now() - t0,
          hopIndex: hop + 1, toolUses: calls.length, textChars: text.length,
        })

        if (calls.length === 0) {
          if (this.steerQueue.length) {
            this.pushUser(this.steerQueue.splice(0).join('\n\n'))
            continue
          }
          if (nudges >= STATUS_NUDGE_LIMIT) {
            return { ...base, usage, ...failure('unknown', 'stopped after repeated turns without set_turn_status') }
          }
          nudges++
          this.pushUser(text
            ? 'Your plain text was not shown to anyone. If it should be seen, post it with the Cumora tool, then call set_turn_status.'
            : 'You stopped without declaring your turn state. Call set_turn_status (done, continue, needs_clarification, blocked or waiting).')
          continue
        }

        // Replay the calls in input shape so every output below has its call.
        for (const c of calls) {
          this.history.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments } as ResponseInputItem)
        }
        const outcomes = await Promise.all(calls.map((c) => runTool(c.name, c.arguments, {
          home: this.opts.home, runtimeCli: this.opts.runtimeCli, signal: abort.signal,
        })))
        let terminal = false
        calls.forEach((c, i) => {
          this.history.push({ type: 'function_call_output', call_id: c.call_id, output: outcomes[i].output } as ResponseInputItem)
          const st = outcomes[i].turnStatus
          if (st && isTerminalTurnStatus(st.status)) terminal = true
        })
        if (this.steerQueue.length) {
          // A message that arrived mid-turn may change the answer: keep going.
          this.pushUser(this.steerQueue.splice(0).join('\n\n'))
          continue
        }
        if (terminal) return { ...base, exitCode: 0, usage }
      }
      return { ...base, usage, ...failure('unknown', `stopped at the ${maxHops}-hop limit`) }
    } catch (err) {
      if (err instanceof ResponsesError) return { ...base, usage, ...failure(err.kind, err.message) }
      const message = err instanceof Error ? err.message : String(err)
      return { ...base, usage, ...failure(abort.signal.aborted ? 'unknown' : 'transport', message) }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null
    }
  }
}
