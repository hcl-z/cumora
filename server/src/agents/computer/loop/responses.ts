/**
 * A minimal streaming client for the OpenAI Responses API, for the in-process
 * `loop` engine.
 *
 * Deliberately `fetch` + a small SSE reader instead of the `openai` SDK: the
 * daemon ships as one self-contained bundle (agent-cli), and the SDK would be
 * most of its weight. Only types are imported from the SDK, which erase at
 * build time. Events are handed to turn-stream.ts's reducer unchanged.
 */
import type { ResponseInputItem, ResponseStreamEvent, Tool } from 'openai/resources/responses/responses'
import { applyResponseStreamEvent, consumeResponseStream, newResponseStreamState } from '../../turn-stream.js'
import type { EngineFailureKind } from '../engine.js'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

export interface ResponsesConfig {
  apiKey: string
  baseUrl: string
}

/** The daemon's own provider key. Like the CLI engines' logins, it never
 *  leaves this machine and never reaches the server or the model. */
export function responsesConfigFromEnv(env: NodeJS.ProcessEnv): ResponsesConfig | null {
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  if (!apiKey) return null
  const baseUrl = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
  return { apiKey, baseUrl }
}

export interface ResponsesRequest {
  model: string
  instructions?: string
  input: ResponseInputItem[]
  tools?: Tool[]
  maxOutputTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
}

/** A failed provider call, already classified for the daemon's EngineFailure. */
export class ResponsesError extends Error {
  constructor(
    message: string,
    readonly kind: EngineFailureKind,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'ResponsesError'
  }
}

export function classifyResponsesFailure(status: number | null, body: string): EngineFailureKind {
  if (status === 429) return 'rate-limit'
  if (status === 401 || status === 403) return 'authentication'
  if (/context[_ ]length|maximum context|too many tokens|context window/i.test(body)) return 'context-overflow'
  if (status === null || status >= 500) return 'transport'
  return 'unknown'
}

/** Split an SSE byte stream into `data:` payloads. Events may span chunks and
 *  multi-byte characters may split across them; both are reassembled here. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = function* (final: boolean): Generator<string> {
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0 || (final && buffer.trim())) {
      const block = boundary >= 0 ? buffer.slice(0, boundary) : buffer
      buffer = boundary >= 0 ? buffer.slice(boundary + 2) : ''
      const data = block.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) yield data
      boundary = buffer.indexOf('\n\n')
    }
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    yield* drain(false)
  }
  buffer += decoder.decode()
  yield* drain(true)
}

export type StreamResponses = (req: ResponsesRequest, signal: AbortSignal) => AsyncIterable<ResponseStreamEvent>

/** Connection failures are retried; rate limits, auth and bad requests are
 *  not (the daemon owns rate-limit cooldown). Same budget as turn.ts. */
export const TRANSPORT_RETRY_LIMIT = 2
export const TRANSPORT_RETRY_BASE_MS = 500

/** A stream timeout is not retried: the idle/wall budgets already spent
 *  minutes, and the daemon reports the turn instead. */
export function isRetryableTransport(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false
  if (err instanceof ResponsesError) return err.kind === 'transport'
  // A body that dies mid-read surfaces as a plain undici error.
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /connection error|terminated|socket|econnreset|und_err|fetch failed/.test(text)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Run `attempt` with up to TRANSPORT_RETRY_LIMIT retries on connection
 *  failures, backing off base·2^(n-1). A retry is safe because a hop appends
 *  nothing to history and runs no tool until its stream has completed. */
export async function withTransportRetry<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal,
  opts: { baseMs?: number; onRetry?: (n: number, err: unknown) => void } = {},
): Promise<T> {
  const base = opts.baseMs ?? TRANSPORT_RETRY_BASE_MS
  for (let n = 0; ; n++) {
    try {
      return await attempt()
    } catch (err) {
      if (n >= TRANSPORT_RETRY_LIMIT || !isRetryableTransport(err, signal)) throw err
      opts.onRetry?.(n + 1, err)
      await sleep(base * 2 ** n, signal)
      if (signal.aborted) throw err
    }
  }
}

export interface CompletedText {
  text: string
  /** Raw OpenAI usage from response.completed, if any. */
  usage: unknown
  latencyMs: number
}

/** One tool-free completion: send `prompt`, collect the final text. */
export async function completeText(
  stream: StreamResponses,
  req: Omit<ResponsesRequest, 'input' | 'tools'> & { prompt: string },
  signal: AbortSignal,
): Promise<CompletedText> {
  const t0 = Date.now()
  const state = newResponseStreamState()
  const { prompt, ...rest } = req
  await consumeResponseStream(
    stream({ ...rest, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] } as ResponseInputItem] }, signal),
    (event) => applyResponseStreamEvent(state, event),
  )
  return {
    text: Array.from(state.responseTextByPart.values()).join('\n').trim(),
    usage: state.responseUsage,
    latencyMs: Date.now() - t0,
  }
}

/** Build a streaming caller bound to one key/base URL. */
export function createResponsesStreamer(config: ResponsesConfig): StreamResponses {
  return async function* streamResponses(req, signal) {
    let res: Response
    try {
      res = await fetch(`${config.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          instructions: req.instructions,
          input: req.input,
          tools: req.tools,
          tool_choice: req.tools?.length ? 'auto' : undefined,
          max_output_tokens: req.maxOutputTokens,
          reasoning: req.reasoningEffort ? { effort: req.reasoningEffort } : undefined,
          stream: true,
          store: false,
        }),
        signal,
      })
    } catch (err) {
      if (signal.aborted) throw err
      throw new ResponsesError(`OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`, 'transport')
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      const kind = classifyResponsesFailure(res.status, text)
      // "rate limit" in the message is what the daemon's throttling path keys on.
      const label = kind === 'rate-limit' ? 'rate limited' : 'request failed'
      throw new ResponsesError(`OpenAI ${label} (HTTP ${res.status}): ${text.slice(0, 300)}`, kind, res.status)
    }
    for await (const data of sseData(res.body as unknown as AsyncIterable<Uint8Array>)) {
      if (data === '[DONE]') return
      let event: ResponseStreamEvent
      try { event = JSON.parse(data) as ResponseStreamEvent } catch { continue }
      if (event.type === 'error') {
        const message = (event as { message?: string }).message ?? 'stream error'
        throw new ResponsesError(`OpenAI stream error: ${message}`, classifyResponsesFailure(null, message))
      }
      if (event.type === 'response.failed') {
        const message = event.response.error?.message ?? 'response failed'
        throw new ResponsesError(`OpenAI response failed: ${message}`, classifyResponsesFailure(null, message))
      }
      yield event
    }
  }
}
