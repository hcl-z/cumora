/**
 * On-disk history for one `loop` session, so a daemon restart resumes the
 * conversation instead of starting cold.
 *
 * Layout: `<dir>/history.jsonl`, where `<dir>` is daemon-owned and outside the
 * agent home (the model cannot rewrite its own past). Line 1 is a header
 * naming the session; every later line is one ResponseInputItem. New items are
 * appended after each hop; a compaction rewrites the file atomically.
 *
 * The file holds the bot's conversation and tool output, so the directory is
 * 0700 and the file 0600.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFile, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResponseInputItem } from 'openai/resources/responses/responses'

export const HISTORY_FILE = 'history.jsonl'
const FORMAT = 'cumora-loop-history'
const VERSION = 1

interface Header { format: string; version: number; sessionId: string }

export type LoadResult =
  | { ok: true; items: ResponseInputItem[]; repaired: number }
  | { ok: false; reason: string }

function callIdOf(item: ResponseInputItem): { kind: 'call' | 'output'; id: string } | null {
  const r = item as unknown as { type?: unknown; call_id?: unknown }
  if (typeof r.call_id !== 'string' || !r.call_id) return null
  if (r.type === 'function_call') return { kind: 'call', id: r.call_id }
  if (r.type === 'function_call_output') return { kind: 'output', id: r.call_id }
  return null
}

/** Drop any function_call without its output and vice versa. The API rejects
 *  either orphan, and a crash between the two writes can leave one. */
export function repairPairs(items: ResponseInputItem[]): { items: ResponseInputItem[]; dropped: number } {
  const calls = new Set<string>()
  const outputs = new Set<string>()
  for (const item of items) {
    const k = callIdOf(item)
    if (k?.kind === 'call') calls.add(k.id)
    else if (k?.kind === 'output') outputs.add(k.id)
  }
  const kept = items.filter((item) => {
    const k = callIdOf(item)
    return !k || (calls.has(k.id) && outputs.has(k.id))
  })
  return { items: kept, dropped: items.length - kept.length }
}

/** Read a session's history. Only a torn LAST line (a crash mid-append) is
 *  tolerated; any other damage, or a header for a different session, fails
 *  so the caller starts fresh rather than resuming a corrupted context. */
export function loadHistory(dir: string, sessionId: string): LoadResult {
  let raw: string
  try {
    raw = readFileSync(join(dir, HISTORY_FILE), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { ok: false, reason: code === 'ENOENT' ? 'no history file' : `history unreadable (${code ?? 'error'})` }
  }
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let header: Header
  try { header = JSON.parse(lines[0] ?? '') as Header } catch { return { ok: false, reason: 'history header is corrupt' } }
  if (header?.format !== FORMAT || header.version !== VERSION) return { ok: false, reason: 'history format not recognized' }
  if (header.sessionId !== sessionId) return { ok: false, reason: 'history belongs to another session' }
  const items: ResponseInputItem[] = []
  for (let i = 1; i < lines.length; i++) {
    try {
      const item = JSON.parse(lines[i]) as unknown
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('not an object')
      items.push(item as ResponseInputItem)
    } catch {
      if (i === lines.length - 1) break
      return { ok: false, reason: `history line ${i + 1} is corrupt` }
    }
  }
  const { items: repairedItems, dropped } = repairPairs(items)
  return { ok: true, items: repairedItems, repaired: dropped }
}

/** Writes one session's history. Failures are reported through `onError`
 *  and retried as a full rewrite on the next sync: losing persistence must
 *  never fail the turn that is running in memory. */
export class HistoryStore {
  private written = 0
  private rewrite = true
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly sessionId: string,
    private readonly onError: (message: string) => void,
    /** Items already on disk when resuming. */
    persisted = 0,
  ) {
    if (persisted > 0) {
      this.written = persisted
      this.rewrite = false
    }
  }

  /** The in-memory history was replaced (compaction): rewrite, don't append. */
  invalidate(): void { this.rewrite = true }

  /** Persist `history`. Calls are serialized so appends never interleave. */
  sync(history: readonly ResponseInputItem[]): Promise<void> {
    const snapshot = history.slice()
    this.chain = this.chain.then(() => this.write(snapshot))
    return this.chain
  }

  private async write(history: ResponseInputItem[]): Promise<void> {
    const file = join(this.dir, HISTORY_FILE)
    try {
      if (this.rewrite || history.length < this.written) {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        await chmod(this.dir, 0o700)
        const header: Header = { format: FORMAT, version: VERSION, sessionId: this.sessionId }
        const body = [header, ...history].map((v) => JSON.stringify(v)).join('\n') + '\n'
        const tmp = join(this.dir, `.${HISTORY_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
        try {
          await writeFile(tmp, body, { mode: 0o600 })
          await rename(tmp, file)
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => {})
          throw err
        }
        this.rewrite = false
      } else if (history.length > this.written) {
        const lines = history.slice(this.written).map((v) => JSON.stringify(v)).join('\n') + '\n'
        await appendFile(file, lines, { mode: 0o600 })
      }
      this.written = history.length
    } catch (err) {
      this.rewrite = true
      this.onError(`loop history write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
