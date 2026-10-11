/**
 * A record/replay stand-in for the OpenAI Responses API, for daemon e2e
 * tests. The server and the daemon both point OPENAI_BASE_URL at it.
 *
 * Replay: each request is matched against a cassette — an ordered list of
 * interactions, each used once. A request with tools is an agent hop
 * (`kind: 'agent'`); one without is a one-shot call (triage, compaction,
 * completion verification). An interaction may also require the request's
 * flattened input to match a regex, whose named groups can be substituted
 * into the response as `{{name}}` — that is how a recorded reply follows
 * the conversation id of the current run.
 *
 * Record: requests are forwarded to `upstream` (the real API), the stream is
 * relayed to the caller, and the events are appended to the cassette for
 * `save()`. Values listed in `redact` are replaced by `{{name}}` so a
 * recording can be replayed against a fresh stack.
 *
 * An agent request that matches nothing gets HTTP 500 and is kept in
 * `unmatched`, so a test fails loudly instead of hanging on a silent bot.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'

export type InteractionKind = 'agent' | 'oneshot'

export interface Interaction {
  kind: InteractionKind
  /** Regex the flattened request input must match; named groups are captured. */
  match?: string
  /** Optional model the request must name. */
  model?: string
  /** Server-sent events to stream back, in order. */
  events: Array<Record<string, unknown>>
  note?: string
}

export interface Cassette {
  version: 1
  interactions: Interaction[]
  /** Answer for one-shot calls nothing else matched (left unset → HTTP 500). */
  fallbackOneshot?: string
}

export interface ReceivedRequest {
  kind: InteractionKind
  model: string
  input: string
  matched: number | null
  at: number
}

export interface FakeOpenAIOptions {
  cassette?: Cassette
  /** Forward to this base URL and record (e.g. https://api.openai.com/v1). */
  upstream?: { baseUrl: string; apiKey: string }
  /** Literal → placeholder name, applied to recorded responses. */
  redact?: Record<string, string>
}

/** Flatten a request's input to the text a matcher sees. */
export function flattenInput(body: { instructions?: unknown; input?: unknown }): string {
  const parts: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>
      for (const key of ['text', 'content', 'output', 'arguments']) if (key in r) walk(r[key])
    }
  }
  walk(body.input)
  return parts.join('\n')
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]))
  }
  return value
}

/** Minimal events for a one-shot text answer. */
export function textEvents(text: string): Array<Record<string, unknown>> {
  return [
    { type: 'response.output_text.done', item_id: 'msg_fake', output_index: 0, content_index: 0, text },
    completedEvent(),
  ]
}

/** Events for an agent hop that calls the given tools. */
export function toolCallEvents(calls: Array<{ name: string; args: unknown }>, prefix = 'call'): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = calls.map((c, i) => ({
    type: 'response.output_item.added',
    output_index: i,
    item: { type: 'function_call', id: `fc_${prefix}_${i}`, call_id: `${prefix}_${i}`, name: c.name, arguments: JSON.stringify(c.args) },
  }))
  events.push(completedEvent())
  return events
}

function completedEvent(): Record<string, unknown> {
  return {
    type: 'response.completed',
    response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } },
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function sse(res: ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  res.end('data: [DONE]\n\n')
}

export class FakeOpenAI {
  readonly received: ReceivedRequest[] = []
  readonly unmatched: ReceivedRequest[] = []
  private readonly used = new Set<number>()
  private readonly recorded: Interaction[] = []
  private server: Server | null = null
  baseUrl = ''

  constructor(private readonly opts: FakeOpenAIOptions = {}) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}/v1`
    return this.baseUrl
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  /** Interactions of the loaded cassette nobody asked for. */
  unusedInteractions(): Interaction[] {
    return (this.opts.cassette?.interactions ?? []).filter((_, i) => !this.used.has(i))
  }

  async save(path: string): Promise<void> {
    const cassette: Cassette = { version: 1, interactions: this.recorded }
    await writeFile(path, `${JSON.stringify(cassette, null, 2)}\n`)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST' || !path.endsWith('/responses')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `fake-openai: ${req.method} ${path} is not implemented` } }))
      return
    }
    let body: { model?: unknown; tools?: unknown; instructions?: unknown; input?: unknown }
    const raw = await readBody(req)
    try { body = JSON.parse(raw) } catch {
      res.writeHead(400).end()
      return
    }
    const kind: InteractionKind = Array.isArray(body.tools) && body.tools.length > 0 ? 'agent' : 'oneshot'
    const model = typeof body.model === 'string' ? body.model : ''
    const input = flattenInput(body)
    const record: ReceivedRequest = { kind, model, input, matched: null, at: Date.now() }
    this.received.push(record)

    if (this.opts.upstream) {
      await this.forward(raw, kind, res)
      return
    }

    const interactions = this.opts.cassette?.interactions ?? []
    for (const [i, it] of interactions.entries()) {
      if (this.used.has(i) || it.kind !== kind) continue
      if (it.model && it.model !== model) continue
      let vars: Record<string, string> = {}
      if (it.match) {
        const m = new RegExp(it.match, 's').exec(input)
        if (!m) continue
        vars = { ...(m.groups ?? {}) }
      }
      this.used.add(i)
      record.matched = i
      sse(res, substitute(it.events, vars) as Array<Record<string, unknown>>)
      return
    }
    if (kind === 'oneshot' && this.opts.cassette?.fallbackOneshot !== undefined) {
      sse(res, textEvents(this.opts.cassette.fallbackOneshot))
      return
    }
    this.unmatched.push(record)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `fake-openai: no cassette interaction matches this ${kind} request` } }))
  }

  private async forward(raw: string, kind: InteractionKind, res: ServerResponse): Promise<void> {
    const { baseUrl, apiKey } = this.opts.upstream!
    const up = await fetch(`${baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: raw,
    })
    const text = await up.text()
    if (!up.ok) {
      res.writeHead(up.status, { 'Content-Type': 'application/json' })
      res.end(text)
      return
    }
    const events = text.split('\n\n')
      .map((block) => block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
      .filter((d) => d && d !== '[DONE]')
      .flatMap((d) => { try { return [JSON.parse(d) as Record<string, unknown>] } catch { return [] } })
    let redacted: unknown = events
    for (const [literal, name] of Object.entries(this.opts.redact ?? {})) {
      redacted = JSON.parse(JSON.stringify(redacted).split(literal).join(`{{${name}}}`))
    }
    this.recorded.push({ kind, events: redacted as Array<Record<string, unknown>> })
    sse(res, events)
  }
}

export async function loadCassette(path: string): Promise<Cassette> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Cassette
  if (parsed.version !== 1 || !Array.isArray(parsed.interactions)) throw new Error(`${path}: not a v1 cassette`)
  return parsed
}
