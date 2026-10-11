/**
 * One bot's long-lived conversation with the model for the `loop` engine.
 *
 * A turn is a bounded hop loop: compact if the context is getting full,
 * stream one response (connection failures retried), run the requested
 * tools in parallel, and stop only on a terminal set_turn_status that
 * survives completion verification. Plain text without a status is nudged
 * twice, then the turn fails as a protocol violation. A direct message that
 * arrives mid-turn aborts the running tool batch and is delivered at once;
 * other steering waits for the hop boundary.
 *
 * History spans turns and, given a history dir, is persisted after every hop
 * so a restarted daemon resumes the same session (history.ts).
 */
import { randomUUID } from 'node:crypto'
import type { ResponseInputItem } from 'openai/resources/responses/responses'
import type { CliSideEffect } from '../../cli-result.js'
import { applyResponseStreamEvent, consumeResponseStream, newResponseStreamState } from '../../turn-stream.js'
import type { EngineHopReport, EngineRunResult, EngineSession, EngineUsage } from '../engine.js'
import { compactLoopHistory, formatItemsForSummary, requestOverheadTokens, summaryInstructions, type SummaryScope } from './compaction.js'
import { HistoryStore, loadHistory } from './history.js'
import { ResponsesError, type ResponsesConfig, type StreamResponses, completeText, createResponsesStreamer, withTransportRetry } from './responses.js'
import { type ConnectorBroker, type RuntimeCliInvoker, type ToolOutcome, isTerminalTurnStatus, loopToolDefs, runTool } from './tools.js'
import { MAX_VERIFICATIONS_PER_TURN, type DeclaredStatus, rejectionMessage, shouldVerifyTerminalCompletion, verifyTerminalCompletion } from './verify.js'

export const LOOP_MAX_HOPS = 200
const MAX_OUTPUT_TOKENS = 4000
/** Hops that end with no tool call and no status before the turn is failed. */
const STATUS_NUDGE_LIMIT = 2

export interface LoopSessionOptions {
  /** realpath of the agent home. */
  home: string
  model: string
  /** Auxiliary model for compaction and completion verification. */
  fastModel?: string
  instructions: string
  config: ResponsesConfig | null
  runtimeCli: RuntimeCliInvoker | null
  onLog: (line: string) => void
  onHopUsage?: (report: EngineHopReport) => void
  /** Daemon-owned directory for history.jsonl; omit to keep history in memory. */
  historyDir?: string | null
  /** Resume this session's history from `historyDir`; a fresh session starts
   *  if it cannot be read. */
  resumeSessionId?: string | null
  /** Name the verifier and summarizer refer to. */
  botName?: string
  /** The bot's Broker; when set, the connector tools are offered. */
  broker?: ConnectorBroker | null
  /** Injected in tests; defaults to the real Responses API. */
  stream?: StreamResponses
  maxHops?: number
  retryBaseMs?: number
  verifierTimeoutMs?: number
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

function totalInput(u: EngineUsage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
}

function failure(kind: NonNullable<EngineRunResult['failure']>['kind'], message: string): Pick<EngineRunResult, 'exitCode' | 'error' | 'failure'> {
  return { exitCode: 1, error: message, failure: { kind, message, diagnostic: message } }
}

function userItem(text: string): ResponseInputItem {
  return { role: 'user', content: [{ type: 'input_text', text }] } as ResponseInputItem
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Shown in place of a tool's result when a direct message cut it short. The
 *  call may still have taken effect (a reply may have posted), so the model
 *  is told to check instead of blindly repeating it. */
export const INTERRUPTED_TOOL_OUTPUT = 'interrupted: a direct message arrived while this ran, so it was cancelled. It may or may not have taken effect; check before repeating it.'

const STATUS_NUDGE_TEXT = [
  'Internal protocol check: you produced assistant text, but Cumora users cannot see plain assistant output.',
  'Continue this same turn using tools. If the draft should be visible, post it with the Cumora tool (reply), then call set_turn_status.',
]
const STATUS_NUDGE_SILENT = [
  'Internal protocol check: you ended the hop without declaring turn status.',
  'Continue this same turn and call set_turn_status with the semantic state: done, continue, needs_clarification, blocked, or waiting.',
  'Do not rely on silence to mean done.',
]

export class LoopSession implements EngineSession {
  readonly sessionId: string
  readonly carriesStandingPrompt = true
  private history: ResponseInputItem[] = []
  private steerQueue: string[] = []
  private turnAbort: AbortController | null = null
  private batchAbort: AbortController | null = null
  private stopped = false
  private readonly stream: StreamResponses | null
  private readonly store: HistoryStore | null
  private readonly fastModel: string
  private readonly botName: string

  constructor(private readonly opts: LoopSessionOptions) {
    this.stream = opts.stream ?? (opts.config ? createResponsesStreamer(opts.config) : null)
    this.fastModel = opts.fastModel || opts.model
    this.botName = opts.botName || 'the agent'
    let sessionId = `loop-${randomUUID()}`
    let persisted = 0
    if (opts.resumeSessionId && opts.historyDir) {
      const loaded = loadHistory(opts.historyDir, opts.resumeSessionId)
      if (loaded.ok) {
        sessionId = opts.resumeSessionId
        this.history = loaded.items
        persisted = loaded.repaired > 0 ? 0 : loaded.items.length
        opts.onLog(`[loop] resumed session ${sessionId} with ${loaded.items.length} history item(s)${loaded.repaired ? `, dropped ${loaded.repaired} unpaired` : ''}`)
      } else {
        opts.onLog(`[loop] could not resume ${opts.resumeSessionId} (${loaded.reason}); starting a fresh session`)
      }
    }
    this.sessionId = sessionId
    this.store = opts.historyDir ? new HistoryStore(opts.historyDir, sessionId, opts.onLog, persisted) : null
  }

  get alive(): boolean { return !this.stopped }

  /** Number of items in the session's history (tests, diagnostics). */
  get historyLength(): number { return this.history.length }

  steer(text: string, opts?: { interrupt?: boolean }): void {
    if (!this.turnAbort || !text.trim()) return
    this.steerQueue.push(text)
    if (opts?.interrupt) this.batchAbort?.abort()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.turnAbort?.abort()
    await this.store?.sync(this.history)
  }

  private async summarize(items: ResponseInputItem[], scope: SummaryScope, signal: AbortSignal): Promise<string> {
    const flattened = formatItemsForSummary(items)
    if (!flattened) return '(no earlier work to summarize)'
    const call = await completeText(this.stream!, {
      model: this.fastModel,
      instructions: summaryInstructions(scope, this.botName),
      prompt: `${scope === 'turn' ? 'Earlier tool calls and outputs for this turn' : 'Earlier turns of this conversation'} (${items.length} items):\n\n${flattened}`,
      maxOutputTokens: 1500,
      reasoningEffort: 'low',
    }, signal)
    this.opts.onHopUsage?.({ model: this.fastModel, usage: engineUsageFromOpenAI(call.usage), latencyMs: call.latencyMs, purpose: 'compaction' })
    if (!call.text) throw new Error('empty summary from LLM')
    return call.text
  }

  /** Run one batch; a direct-message steer aborts whatever is still running. */
  private async runBatch(calls: Array<{ name: string; arguments: string }>, turnSignal: AbortSignal): Promise<{ outcomes: ToolOutcome[]; interrupted: boolean }> {
    const batch = new AbortController()
    this.batchAbort = batch
    const signal = AbortSignal.any([turnSignal, batch.signal])
    const cancelled = new Promise<ToolOutcome>((resolve) => {
      const done = () => resolve({ output: INTERRUPTED_TOOL_OUTPUT })
      if (signal.aborted) done()
      else signal.addEventListener('abort', done, { once: true })
    })
    try {
      const outcomes = await Promise.all(calls.map((c) => Promise.race([
        runTool(c.name, c.arguments, { home: this.opts.home, runtimeCli: this.opts.runtimeCli, signal, broker: this.opts.broker ?? null }),
        cancelled,
      ])))
      return { outcomes, interrupted: batch.signal.aborted && !turnSignal.aborted }
    } finally {
      if (this.batchAbort === batch) this.batchAbort = null
    }
  }

  async send(prompt: string): Promise<EngineRunResult> {
    const base = { sessionId: this.sessionId, model: this.opts.model }
    if (!this.stream) {
      return { ...base, ...failure('authentication', 'OPENAI_API_KEY is not set for the daemon (api key missing)') }
    }
    const stream = this.stream
    const abort = new AbortController()
    this.turnAbort = abort
    this.steerQueue = []
    let turnStart = this.history.length
    this.history.push(userItem(prompt))
    this.opts.broker?.beginTurn()
    const tools = loopToolDefs(!!this.opts.broker)
    let usage: EngineUsage = {}
    let lastInputTokens = 0
    let nudges = 0
    let verifications = 0
    let sideEffects: CliSideEffect[] = []
    const overhead = requestOverheadTokens(this.opts.instructions, tools)
    try {
      const maxHops = this.opts.maxHops ?? LOOP_MAX_HOPS
      for (let hop = 0; hop < maxHops; hop++) {
        if (this.stopped) return { ...base, usage, ...failure('unknown', 'session stopped') }
        await this.store?.sync(this.history)

        const compacted = await compactLoopHistory({
          history: this.history, turnStart, model: this.opts.model, extraTokens: overhead, lastInputTokens,
          summarize: (items, scope) => this.summarize(items, scope, abort.signal),
          onLog: this.opts.onLog,
        })
        if (compacted.changed) {
          this.history = compacted.history
          turnStart = compacted.turnStart
          lastInputTokens = 0
          this.store?.invalidate()
          this.opts.onLog(`[loop] compacted history to ~${compacted.tokens} tokens${compacted.earlierItemsFolded ? ` (folded ${compacted.earlierItemsFolded} earlier item(s))` : ''}`)
        }
        if (compacted.overHardLimit) {
          return { ...base, usage, ...failure('context-overflow', `loop history still exceeds the context window after compaction (~${compacted.tokens} tokens)`) }
        }

        const t0 = Date.now()
        const state = await withTransportRetry(async () => {
          const s = newResponseStreamState()
          await consumeResponseStream(
            stream({
              model: this.opts.model,
              instructions: this.opts.instructions,
              input: this.history,
              tools,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              reasoningEffort: 'low',
            }, abort.signal),
            (event) => applyResponseStreamEvent(s, event),
          )
          return s
        }, abort.signal, {
          baseMs: this.opts.retryBaseMs,
          onRetry: (n, err) => this.opts.onLog(`[loop] model connection failed (${errorText(err).slice(0, 160)}); retry ${n}`),
        })
        const hopUsage = engineUsageFromOpenAI(state.responseUsage)
        usage = addUsage(usage, hopUsage)
        lastInputTokens = totalInput(hopUsage) + (hopUsage.output_tokens ?? 0)
        const calls = Object.values(state.pendingTools)
        const text = Array.from(state.responseTextByPart.values()).join('\n').trim()
        this.opts.onHopUsage?.({
          model: this.opts.model, usage: hopUsage, latencyMs: Date.now() - t0,
          hopIndex: hop + 1, toolUses: calls.length, textChars: text.length,
        })

        if (calls.length === 0) {
          if (this.steerQueue.length) {
            this.history.push(userItem(this.steerQueue.splice(0).join('\n\n')))
            continue
          }
          if (nudges >= STATUS_NUDGE_LIMIT) {
            return { ...base, usage, ...failure('unknown', 'Stopped after repeated missing turn-status declarations (protocol violation)') }
          }
          nudges++
          this.history.push(userItem((text ? [...STATUS_NUDGE_TEXT, 'Draft assistant text:', text.slice(0, 4000)] : STATUS_NUDGE_SILENT).join('\n')))
          continue
        }

        const { outcomes, interrupted } = await this.runBatch(calls, abort.signal)
        // Calls and outputs go in together so history never holds an orphan.
        for (const c of calls) {
          this.history.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments } as ResponseInputItem)
        }
        let declared: DeclaredStatus | null = null
        for (const [i, c] of calls.entries()) {
          const outcome = outcomes[i]
          this.history.push({ type: 'function_call_output', call_id: c.call_id, output: outcome.output } as ResponseInputItem)
          if (outcome.sideEffects) sideEffects = [...sideEffects, ...outcome.sideEffects]
          if (outcome.turnStatus) declared = outcome.turnStatus
        }
        if (this.steerQueue.length || interrupted) {
          // A message that arrived mid-turn may change the answer: keep going.
          if (this.steerQueue.length) this.history.push(userItem(this.steerQueue.splice(0).join('\n\n')))
          continue
        }
        if (!declared || !isTerminalTurnStatus(declared.status)) continue

        if (verifications < MAX_VERIFICATIONS_PER_TURN && shouldVerifyTerminalCompletion({ status: declared, sideEffects })) {
          verifications++
          let verdict
          try {
            const r = await verifyTerminalCompletion({
              stream, model: this.fastModel, botName: this.botName, context: prompt,
              status: declared, sideEffects, signal: abort.signal, timeoutMs: this.opts.verifierTimeoutMs,
            })
            this.opts.onHopUsage?.({ model: this.fastModel, usage: engineUsageFromOpenAI(r.call.usage), latencyMs: r.call.latencyMs, purpose: 'completion-verify' })
            verdict = r.verdict
          } catch (err) {
            if (abort.signal.aborted) throw err
            // As in turn.ts: a verifier that cannot answer does not wave the turn through.
            verdict = {
              complete: false,
              reason: `completion verifier failed: ${errorText(err)}`,
              nextStep: 'continue the turn and either deliver the requested result or report a clear user-visible failure',
            }
          }
          if (!verdict.complete) {
            this.opts.onLog(`[loop] terminal status rejected: ${verdict.reason.slice(0, 200)}`)
            this.history.push(userItem(rejectionMessage(verdict)))
            continue
          }
        }
        return { ...base, exitCode: 0, usage }
      }
      return { ...base, usage, ...failure('unknown', `stopped at the ${maxHops}-hop limit`) }
    } catch (err) {
      if (err instanceof ResponsesError) return { ...base, usage, ...failure(err.kind, err.message) }
      return { ...base, usage, ...failure(abort.signal.aborted ? 'unknown' : 'transport', errorText(err)) }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null
      await this.store?.sync(this.history)
    }
  }
}
