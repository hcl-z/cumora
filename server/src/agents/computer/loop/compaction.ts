/**
 * Context compaction for the `loop` engine.
 *
 * A loop session's history spans turns, while turn.ts compacts within one
 * turn. So this runs in two steps once the estimate crosses 75% of the
 * window (`compactThresholdFor`, shared with turn.ts):
 *
 * 1. Earlier turns are folded into one summary message. They are finished
 *    work; the bot needs what happened, not the raw transcript.
 * 2. If the current turn alone is still too big, it goes through turn.ts's
 *    own `compactHistoryWithSummary` (truncate outputs, then summarize the
 *    oldest call/output pairs, keeping the most recent ones).
 *
 * Both summaries run on the fast model. If a summary fails, step 1 drops the
 * earlier turns behind a marker and step 2 falls back to drop-and-marker, as
 * turn.ts does.
 */
import type { ResponseInputItem } from 'openai/resources/responses/responses'
import { compactHistoryWithSummary, compactThresholdFor, estimateHistoryTokens, estimateTokens, hardLimitFor } from '../../turn-compaction.js'

export type SummaryScope = 'turn' | 'earlier'
export type Summarize = (items: ResponseInputItem[], scope: SummaryScope) => Promise<string>

const SUMMARY_INPUT_CHARS = 32_000

/** Flatten items for the summarizer, as turn.ts's formatItemsForSummary
 *  does, plus readable text for user/assistant messages, which carry most
 *  of an earlier turn. */
export function formatItemsForSummary(items: ResponseInputItem[]): string {
  const lines: string[] = []
  let used = 0
  let elided = 0
  for (const item of items) {
    const r = item as unknown as Record<string, unknown>
    const type = typeof r?.type === 'string' ? r.type : (typeof r?.role === 'string' ? 'message' : 'unknown')
    let line: string
    if (type === 'function_call') {
      line = `function_call ${String(r.name ?? '?')} (call_id=${String(r.call_id ?? '?')})\n  args: ${String(r.arguments ?? '').slice(0, 600)}`
    } else if (type === 'function_call_output') {
      line = `function_call_output (call_id=${String(r.call_id ?? '?')})\n  output: ${String(r.output ?? '').slice(0, 1200)}`
    } else if (type === 'item_reference') {
      continue
    } else if (type === 'message') {
      const content = r.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map((c) => (c as { text?: unknown })?.text).filter((t) => typeof t === 'string').join('\n') : ''
      line = `${String(r.role ?? 'message')}: ${text.slice(0, 2000)}`
    } else {
      line = `${type}: ${JSON.stringify(r).slice(0, 600)}`
    }
    if (used + line.length > SUMMARY_INPUT_CHARS) { elided++; continue }
    lines.push(line)
    used += line.length + 2
  }
  if (elided > 0) lines.push(`[+${elided} more item${elided === 1 ? '' : 's'} elided to fit the summarizer's input budget]`)
  return lines.join('\n\n')
}

export function summaryInstructions(scope: SummaryScope, botName: string): string {
  if (scope === 'turn') {
    // turn.ts summarizeHistoryItems, unchanged.
    return `You are summarizing earlier tool work that agent "${botName}" did during a single turn, so the agent can continue without seeing the raw history. Write a concise, factual "what I've done so far" note (≤ 800 words) that includes:

- Which tools were called, and what each returned (paths, IDs, key strings, error messages — keep the SPECIFIC data, not the generalities)
- What was learned or decided as a result
- Anything the agent should remember to do NEXT

Skip narrative framing. No headings, no bullet symbols unless they aid clarity. Plain paragraphs. Treat the output as a private memo to your future self.`
  }
  return `You are summarizing agent "${botName}"'s earlier, finished turns so it can keep working without the raw transcript. Write a concise, factual memo (≤ 800 words) that keeps:

- Who asked for what, in which conversation (keep conversation ids, message ids, names)
- What the agent did and delivered, and what is still open or promised
- Specific facts it learned that later work may need (ids, paths, numbers, decisions, preferences)

Skip narrative framing and anything already resolved that later work cannot need. Plain paragraphs. Treat the output as a private memo to your future self.`
}

function memo(text: string): ResponseInputItem {
  return { role: 'user', content: [{ type: 'input_text', text }] } as ResponseInputItem
}

export interface CompactOutcome {
  history: ResponseInputItem[]
  /** Index of the current turn's first item in the new history. */
  turnStart: number
  changed: boolean
  /** Estimated tokens of the new history plus `extraTokens`. */
  tokens: number
  /** Over the 95% hard limit even after compacting. */
  overHardLimit: boolean
  earlierItemsFolded: number
  usedSummary: boolean
}

/** Tokens the request adds beyond the history (instructions, tool schemas). */
export function requestOverheadTokens(instructions: string, tools: unknown): number {
  return estimateTokens(instructions) + estimateTokens(JSON.stringify(tools ?? []))
}

export async function compactLoopHistory(args: {
  history: ResponseInputItem[]
  turnStart: number
  model: string
  extraTokens: number
  /** Authoritative size of the last request, when known; the estimate can
   *  undercount, so the larger of the two decides. */
  lastInputTokens?: number
  summarize: Summarize
  onLog?: (line: string) => void
}): Promise<CompactOutcome> {
  const threshold = compactThresholdFor(args.model)
  const hardLimit = hardLimitFor(args.model)
  let history = args.history
  let turnStart = Math.min(Math.max(0, args.turnStart), history.length)
  let tokens = estimateHistoryTokens(history) + args.extraTokens
  const measured = Math.max(tokens, args.lastInputTokens ?? 0)
  const base = { earlierItemsFolded: 0, usedSummary: false }
  if (measured <= threshold) {
    return { history, turnStart, changed: false, tokens, overHardLimit: tokens > hardLimit, ...base }
  }

  let changed = false
  let usedSummary = false
  let earlierItemsFolded = 0
  if (turnStart > 0) {
    const earlier = history.slice(0, turnStart)
    let text: string
    try {
      const summary = (await args.summarize(earlier, 'earlier')).trim()
      if (!summary) throw new Error('empty summary')
      text = `[auto-compaction · ${earlier.length} earlier conversation item${earlier.length === 1 ? '' : 's'} from previous turns summarized below — this is background; the current turn follows]\n\n${summary}`
      usedSummary = true
    } catch (err) {
      args.onLog?.(`[loop] summarizing earlier turns failed, dropping them: ${err instanceof Error ? err.message : String(err)}`)
      text = `[auto-compaction] ${earlier.length} earlier conversation item${earlier.length === 1 ? ' was' : 's were'} dropped from history to fit the context budget. Check the conversation with the Cumora tool if you need earlier context.`
    }
    history = [memo(text), ...history.slice(turnStart)]
    turnStart = 1
    earlierItemsFolded = earlier.length
    changed = true
    tokens = estimateHistoryTokens(history) + args.extraTokens
  }

  if (tokens > threshold) {
    const prefix = history.slice(0, turnStart)
    const prefixTokens = estimateHistoryTokens(prefix) + args.extraTokens
    const result = await compactHistoryWithSummary(
      history.slice(turnStart),
      (n) => n + prefixTokens > threshold,
      (items) => args.summarize(items, 'turn'),
    )
    if (result.truncatedOutputCount > 0 || result.droppedPairCount > 0) changed = true
    usedSummary ||= result.usedLlmSummary
    history = [...prefix, ...result.newHistory]
    tokens = estimateHistoryTokens(history) + args.extraTokens
  }

  return { history, turnStart, changed, tokens, overHardLimit: tokens > hardLimit, earlierItemsFolded, usedSummary }
}
