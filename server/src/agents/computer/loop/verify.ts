/**
 * Completion verification for the `loop` engine, ported from turn.ts
 * (`shouldVerifyTerminalCompletion`, `verifyTerminalCompletion`). When a bot
 * declares done/waiting after acting on the world but without posting a
 * reply, a small model judges whether the side effects were the deliverable
 * or only an acknowledgement (a reaction before the real work).
 *
 * The prompt and parse rules are kept in step with turn.ts by hand: turn.ts
 * pulls in the server's DB and LLM client, which the daemon bundle cannot.
 */
import { type CliSideEffect, cliResultHasReplySideEffect } from '../../cli-result.js'
import { type CompletedText, type StreamResponses, completeText } from './responses.js'
import { type TurnStatus, isTerminalTurnStatus } from './tools.js'

export interface CompletionVerification {
  complete: boolean
  reason: string
  nextStep: string
}

export interface DeclaredStatus { status: TurnStatus; reason: string; nextStep: string }

/** Verifications per turn; past this the terminal status is accepted. */
export const MAX_VERIFICATIONS_PER_TURN = 2
export const VERIFIER_TIMEOUT_MS = 10_000
const CONTEXT_CHARS = 24_000

export function hasReplySideEffect(effects: readonly CliSideEffect[]): boolean {
  return cliResultHasReplySideEffect({ sideEffects: effects })
}

/** turn.ts verifies only when there was an inbox; a loop turn always starts
 *  from a wake prompt, so that precondition is implicit. */
export function shouldVerifyTerminalCompletion(args: {
  status: DeclaredStatus
  sideEffects: readonly CliSideEffect[]
}): boolean {
  if (!isTerminalTurnStatus(args.status.status)) return false
  if (hasReplySideEffect(args.sideEffects)) return false
  return args.sideEffects.length > 0
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    trimmed.match(/\{[\s\S]*\}/)?.[0],
  ].filter((v): v is string => Boolean(v))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Try the next extraction shape.
    }
  }
  return null
}

export function parseCompletionVerification(raw: string): CompletionVerification | null {
  const parsed = extractJsonObject(raw)
  if (!parsed || typeof parsed.complete !== 'boolean') return null
  const reason = String(parsed.reason ?? '').trim().slice(0, 800)
  const nextStep = String(parsed.next_step ?? parsed.nextStep ?? '').trim().slice(0, 800)
  return {
    complete: parsed.complete,
    reason: reason || (parsed.complete ? 'completion accepted' : 'completion rejected'),
    nextStep,
  }
}

function verifierInstructions(botName: string): string {
  return `You are Cumora's turn-completion verifier. Decide whether agent "${botName}" may safely end this turn.

Use semantic judgment, not keyword rules. Read the actual conversation and the actual side effects. A reaction can be a valid lightweight response only when the human did not ask for a deliverable, answer, artifact, image, file, external action, or status report that remains missing. If the human asked for work and the side effects only acknowledge it, completion is false.

Do not require this specific agent to repeat work already genuinely completed by another teammate in the visible context. Do require continuation when nobody has delivered the requested result or a clear user-visible failure/clarifying question.

Reply ONLY as JSON: {"complete":boolean,"reason":"short factual reason","next_step":"what the agent should do next if incomplete, otherwise empty"}.`
}

export async function verifyTerminalCompletion(args: {
  stream: StreamResponses
  model: string
  botName: string
  context: string
  status: DeclaredStatus
  sideEffects: readonly CliSideEffect[]
  signal: AbortSignal
  timeoutMs?: number
}): Promise<{ verdict: CompletionVerification; call: CompletedText }> {
  const timeout = AbortSignal.timeout(args.timeoutMs ?? VERIFIER_TIMEOUT_MS)
  const call = await completeText(args.stream, {
    model: args.model,
    instructions: verifierInstructions(args.botName),
    prompt: [
      'Conversation context visible to the agent:',
      args.context.slice(0, CONTEXT_CHARS),
      '',
      'Agent terminal status declaration:',
      JSON.stringify({ status: args.status.status, reason: args.status.reason, next_step: args.status.nextStep }, null, 2),
      '',
      'World side effects produced during this turn:',
      args.sideEffects.length ? JSON.stringify(args.sideEffects.slice(-20), null, 2) : '(none)',
      '',
      'May the runtime accept this terminal status, or must the same agent continue the turn?',
    ].join('\n'),
    maxOutputTokens: 500,
    reasoningEffort: 'low',
  }, AbortSignal.any([args.signal, timeout]))
  const verdict = parseCompletionVerification(call.text)
  if (!verdict) throw new Error(`completion verifier returned invalid JSON: ${call.text.slice(0, 500)}`)
  return { verdict, call }
}

/** The message a rejected terminal status sends back, as in turn.ts. */
export function rejectionMessage(verdict: CompletionVerification): string {
  return [
    'Internal completion check: your terminal turn status was rejected.',
    `Reason: ${verdict.reason}`,
    `Required next step: ${verdict.nextStep || 'continue and complete the user-visible task'}`,
    '',
    'Continue this same turn. A reaction or short acknowledgement is not the deliverable. Post the requested result with the Cumora tool (reply), ask a concrete clarification, or report a clear failure, then call set_turn_status again.',
  ].join('\n')
}
