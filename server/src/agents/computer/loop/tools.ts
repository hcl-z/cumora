/**
 * The `loop` engine's whole tool surface. There is no shell: the model reads
 * and writes files inside its own home and acts on Cumora through the same
 * argv-only bridge the secure CLI engines get (`mcp__cumora__cli`), so the
 * standing prompt reads identically for every engine.
 *
 * The file tools are the boundary here, not an OS sandbox, so every path is
 * resolved through realpath and must stay inside the agent home.
 */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FunctionTool } from 'openai/resources/responses/responses'
import type { CliSideEffect } from '../../cli-result.js'

/** Matches the MCP bridge so prompts and argv limits read the same. */
export const CUMORA_TOOL_NAME = 'mcp__cumora__cli'
export const MAX_ARGV = 2000
const MAX_READ_BYTES = 512 * 1024
const MAX_WRITE_BYTES = 2 * 1024 * 1024
/** Cap on what one tool result feeds back to the model. */
export const MAX_TOOL_OUTPUT_BYTES = 8_000

export const TURN_STATUSES = ['done', 'continue', 'needs_clarification', 'blocked', 'waiting'] as const
export type TurnStatus = typeof TURN_STATUSES[number]

export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return status === 'done' || status === 'waiting'
}

export const LOOP_TOOL_DEFS: FunctionTool[] = [
  {
    type: 'function',
    name: CUMORA_TOOL_NAME,
    description: 'Act in Cumora. Pass command-line words as argv; put message bodies directly in argv and never use local file paths.',
    parameters: {
      type: 'object',
      properties: { argv: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_ARGV } },
      required: ['argv'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a file in your home directory. Relative paths are resolved against your home.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'write_file',
    description: 'Create or overwrite a file in your home directory. Intermediate directories are created.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'edit_file',
    description: 'Replace exactly one occurrence of old_string with new_string in a file in your home directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'set_turn_status',
    description: 'Declare your turn state before you stop. "done" once the request is handled (or silence is right), "waiting" only after acting and waiting on someone else, "continue" while more work remains, "needs_clarification" or "blocked" when you will tell the person why. Plain text you write is never shown to anyone; post with the Cumora tool.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...TURN_STATUSES] },
        reason: { type: 'string' },
        next_step: { type: 'string' },
      },
      required: ['status', 'reason', 'next_step'],
      additionalProperties: false,
    },
    strict: false,
  },
]

export interface RuntimeCliResult { text?: string; exitCode: number; error?: string; sideEffects?: CliSideEffect[] }
export type RuntimeCliInvoker = (argv: string[], signal: AbortSignal) => Promise<RuntimeCliResult>

export interface ToolContext {
  /** realpath of the agent home; every file path must resolve inside it. */
  home: string
  runtimeCli: RuntimeCliInvoker | null
  signal: AbortSignal
}

export interface ToolOutcome {
  output: string
  turnStatus?: { status: TurnStatus; reason: string; nextStep: string }
  /** World effects the server reported for a Cumora call. */
  sideEffects?: CliSideEffect[]
}

/** Keep the head of oversized output, mark the cut, and never split a UTF-8
 *  character. */
export function truncateOutput(text: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return `${buf.subarray(0, end).toString('utf8')}\n[…truncated: ${buf.byteLength - end} more bytes]`
}

function inside(home: string, candidate: string): boolean {
  const rel = relative(home, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Resolve a model-supplied path to a real location inside `home`, or null.
 *  The nearest existing ancestor is realpath'd so a symlink inside the home
 *  cannot redirect a read or a write outside it. */
export async function resolveInHome(home: string, raw: string): Promise<string | null> {
  if (!raw || raw.length > 4096 || raw.includes('\0')) return null
  const lexical = resolve(home, raw)
  if (!inside(home, lexical)) return null
  let existing = lexical
  const rest: string[] = []
  for (;;) {
    try {
      await lstat(existing)
      break
    } catch {
      if (existing === home) return null
      rest.unshift(existing.slice(dirname(existing).length + 1))
      existing = dirname(existing)
    }
  }
  let real: string
  try { real = await realpath(existing) } catch { return null }
  const target = rest.length ? join(real, ...rest) : real
  return inside(home, target) ? target : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutcome> {
  let args: Record<string, unknown>
  try {
    const parsed = rawArgs ? JSON.parse(rawArgs) : {}
    args = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return { output: 'error: tool arguments were not valid JSON' }
  }

  if (name === CUMORA_TOOL_NAME) {
    const argv = args.argv
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV || argv.some((v) => typeof v !== 'string')) {
      return { output: 'error: invalid Cumora argv' }
    }
    if (argv.some((v) => v === '--file' || v === '--stdin')) {
      return { output: 'error: local file/stdin flags are unavailable; pass body text directly in argv' }
    }
    if (!ctx.runtimeCli) return { output: 'error: Cumora is unreachable from this session' }
    const r = await ctx.runtimeCli(argv as string[], ctx.signal)
    const text = [r.text ?? '', r.error ? `error: ${r.error}` : ''].filter(Boolean).join('\n')
    const prefix = r.exitCode === 0 ? '' : `exit ${r.exitCode}\n`
    const output = truncateOutput(`${prefix}${text}`.trimEnd() || (r.exitCode === 0 ? 'ok' : `exit ${r.exitCode}`))
    return r.sideEffects?.length ? { output, sideEffects: r.sideEffects } : { output }
  }

  if (name === 'set_turn_status') {
    const status = asString(args.status)
    if (!status || !(TURN_STATUSES as readonly string[]).includes(status)) {
      return { output: `error: status must be one of ${TURN_STATUSES.join(', ')}` }
    }
    return {
      output: `turn status recorded: ${status}`,
      turnStatus: { status: status as TurnStatus, reason: asString(args.reason) ?? '', nextStep: asString(args.next_step) ?? '' },
    }
  }

  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
    const raw = asString(args.path) ?? ''
    const path = await resolveInHome(ctx.home, raw)
    if (!path) return { output: `error: path is outside your home directory or invalid: ${raw}` }
    try {
      if (name === 'read_file') {
        const buf = await readFile(path)
        const text = buf.byteLength > MAX_READ_BYTES ? buf.subarray(0, MAX_READ_BYTES).toString('utf8') : buf.toString('utf8')
        return { output: truncateOutput(text) }
      }
      if (name === 'write_file') {
        const content = asString(args.content) ?? ''
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return { output: 'error: content too large' }
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
        return { output: `wrote ${Buffer.byteLength(content)} bytes to ${relative(ctx.home, path)}` }
      }
      const oldString = asString(args.old_string) ?? ''
      const newString = asString(args.new_string) ?? ''
      if (!oldString) return { output: 'error: old_string must not be empty' }
      const current = await readFile(path, 'utf8')
      const first = current.indexOf(oldString)
      if (first < 0) return { output: 'error: old_string not found' }
      if (current.indexOf(oldString, first + oldString.length) >= 0) return { output: 'error: old_string appears more than once' }
      await writeFile(path, current.slice(0, first) + newString + current.slice(first + oldString.length))
      return { output: `edited ${relative(ctx.home, path)}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `error: ${msg.includes('ENOENT') ? `no such file: ${raw}` : msg}` }
    }
  }

  return { output: `error: unknown tool ${name}` }
}
