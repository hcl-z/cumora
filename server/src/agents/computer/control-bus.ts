/**
 * Cluster-wide control channel for one paired Computer daemon.
 *
 * The database remains the durable source of truth for requested work; this bus
 * is only the low-latency nudge that lets an online daemon react immediately
 * instead of waiting for its next heartbeat.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { redis, sub as redisSub } from '../../redis.js'
import { parseComputerControlEvent, type ComputerControlEvent } from './control-event.js'

const CH_COMPUTER_CONTROL_PREFIX = 'cumora:computer-control:'
const SSE_MAX_BUFFERED_BYTES = 1 * 1024 * 1024

interface Subscriber {
  res: Response
  closed: boolean
  authorize?: () => Promise<boolean>
  delivery: Promise<void>
  revoke(): void
}

const subscribers = new Map<string, Set<Subscriber>>()
let redisSubscriberInstalled = false

async function deliverTo(subscriber: Subscriber, event: ComputerControlEvent): Promise<void> {
  if (subscriber.closed) return
  if (subscriber.authorize) {
    try {
      if (!(await subscriber.authorize())) { subscriber.revoke(); return }
    } catch {
      subscriber.revoke()
      return
    }
  }
  if (subscriber.closed) return
  if (subscriber.res.socket && subscriber.res.socket.writableLength > SSE_MAX_BUFFERED_BYTES) {
    subscriber.revoke()
    return
  }
  try {
    subscriber.res.write(`event: ${event.kind}\n`)
    subscriber.res.write(`id: ${event.id}\n`)
    subscriber.res.write(`data: ${JSON.stringify(event)}\n\n`)
  } catch {
    subscriber.revoke()
  }
}

function installRedisSubscriber(): void {
  if (redisSubscriberInstalled) return
  redisSubscriberInstalled = true
  redisSub.on('message', (channel, raw) => {
    if (!channel.startsWith(CH_COMPUTER_CONTROL_PREFIX)) return
    const computerId = channel.slice(CH_COMPUTER_CONTROL_PREFIX.length)
    const set = subscribers.get(computerId)
    if (!set || set.size === 0) return
    const event = parseComputerControlEvent(raw)
    if (!event) return
    for (const subscriber of set) {
      subscriber.delivery = subscriber.delivery
        .then(() => deliverTo(subscriber, event))
        .catch(() => subscriber.revoke())
    }
  })
}

/** Publish an immediate engine-detection nudge. A zero return means no daemon
 * stream is connected; the persisted heartbeat request remains the fallback. */
export async function deliverEngineDetect(computerId: string): Promise<number> {
  const event: ComputerControlEvent = {
    kind: 'engine.detect',
    id: `engine.detect-${randomUUID()}`,
    at: Date.now(),
  }
  return redis.publish(CH_COMPUTER_CONTROL_PREFIX + computerId, JSON.stringify(event))
}

// ── vault requests (docs/personal-bot/mvp-backend-design.md §7.2) ────────
//
// A vault request is relayed to the daemon over its control stream and the
// daemon answers through POST /api/computers/me/vault-ack. The answer is
// parked in Redis under the request id, so the API process holding the
// browser's request sees it whichever process the daemon reached. Only the
// outcome is stored there, never the sealed blob or a value.

const VAULT_PENDING_PREFIX = 'cumora:vault-pending:'
const VAULT_ACK_PREFIX = 'cumora:vault-ack:'
const VAULT_TTL_SECONDS = 60

// A console test call (connector.test) uses the same request/ack round trip;
// its ack also carries the redacted 2KB preview.

export type VaultAck =
  | { ok: true; updatedAt: string; result?: import('../../broker/definition.js').ConnectorTestResult }
  | { ok: false; error: string }
type VaultRequest =
  | { kind: 'vault.put'; connector: string; name: string; sealed: import('../../broker/vault.js').SealedCredential }
  | { kind: 'vault.delete'; connector: string; name: string }
type TestRequest = {
  kind: 'connector.test'
  definition: import('../../broker/definition.js').ConnectorDefinition
  action: string
  args: Record<string, unknown>
}
type DaemonOutcome = { status: 'failed'; error: string } | { status: 'offline' } | { status: 'timeout' }

/** Relay one vault request and wait for the daemon's answer. `offline` means
 *  no daemon stream is connected to receive it. */
export async function requestVault(
  computerId: string,
  request: VaultRequest,
  timeoutMs = 10_000,
): Promise<{ status: 'ok'; updatedAt: string } | DaemonOutcome> {
  const out = await requestDaemon(computerId, request, timeoutMs)
  return out.status === 'ok' ? { status: 'ok', updatedAt: out.ack.updatedAt } : out
}

/** Run a console test call on the daemon. Waits past the executor's 30s. */
export async function requestConnectorTest(
  computerId: string,
  request: TestRequest,
  timeoutMs = 40_000,
): Promise<{ status: 'ok'; result: import('../../broker/definition.js').ConnectorTestResult } | DaemonOutcome> {
  const out = await requestDaemon(computerId, request, timeoutMs)
  if (out.status !== 'ok') return out
  return out.ack.result ? { status: 'ok', result: out.ack.result } : { status: 'failed', error: 'the bot host sent no result' }
}

async function requestDaemon(
  computerId: string,
  request: VaultRequest | TestRequest,
  timeoutMs: number,
): Promise<{ status: 'ok'; ack: Extract<VaultAck, { ok: true }> } | DaemonOutcome> {
  const requestId = randomUUID()
  await redis.set(VAULT_PENDING_PREFIX + requestId, computerId, 'EX', VAULT_TTL_SECONDS)
  const event = { ...request, id: `${request.kind}-${requestId}`, at: Date.now(), requestId } as ComputerControlEvent
  const receivers = await redis.publish(CH_COMPUTER_CONTROL_PREFIX + computerId, JSON.stringify(event))
  if (receivers === 0) {
    await redis.del(VAULT_PENDING_PREFIX + requestId)
    return { status: 'offline' }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const raw = await redis.get(VAULT_ACK_PREFIX + requestId)
    if (raw) {
      await redis.del(VAULT_ACK_PREFIX + requestId, VAULT_PENDING_PREFIX + requestId)
      const ack = JSON.parse(raw) as VaultAck
      return ack.ok ? { status: 'ok', ack } : { status: 'failed', error: ack.error }
    }
    await new Promise((done) => setTimeout(done, 150))
  }
  await redis.del(VAULT_PENDING_PREFIX + requestId)
  return { status: 'timeout' }
}

/** Record the daemon's answer. Only the computer the request was sent to
 *  may answer it; false otherwise (or when it already expired). */
export async function recordVaultAck(computerId: string, requestId: string, ack: VaultAck): Promise<boolean> {
  const target = await redis.get(VAULT_PENDING_PREFIX + requestId)
  if (target !== computerId) return false
  await redis.set(VAULT_ACK_PREFIX + requestId, JSON.stringify(ack), 'EX', VAULT_TTL_SECONDS)
  return true
}

/** Attach the authenticated daemon's long-lived SSE control stream. */
export async function attachComputerControlStream(
  computerId: string,
  res: Response,
  options: { authorize?: () => Promise<boolean> } = {},
): Promise<void> {
  installRedisSubscriber()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let set = subscribers.get(computerId)
  if (!set) { set = new Set(); subscribers.set(computerId, set) }
  const isFirst = set.size === 0
  let ping: ReturnType<typeof setInterval> | null = null
  const subscriber: Subscriber = {
    res,
    closed: false,
    authorize: options.authorize,
    delivery: Promise.resolve(),
    revoke: () => { /* assigned after cleanup is defined */ },
  }
  set.add(subscriber)

  const cleanup = (): void => {
    if (subscriber.closed && !set!.has(subscriber)) return
    subscriber.closed = true
    if (ping) clearInterval(ping)
    set!.delete(subscriber)
    const last = set!.size === 0
    if (last) subscribers.delete(computerId)
    if (last) {
      void redisSub.unsubscribe(CH_COMPUTER_CONTROL_PREFIX + computerId).catch((error) => {
        console.warn('[computer-control] Redis unsubscribe failed:', error instanceof Error ? error.message : String(error))
      })
    }
  }
  subscriber.revoke = () => {
    if (subscriber.closed) return
    try { res.end() } catch { /* ignore */ }
    cleanup()
  }
  res.on('close', cleanup)
  res.on('error', cleanup)

  // Subscribe before announcing readiness so a request cannot fall into a gap.
  if (isFirst) await redisSub.subscribe(CH_COMPUTER_CONTROL_PREFIX + computerId)
  if (subscriber.closed) return
  res.write(`event: ready\ndata: {"computerId":${JSON.stringify(computerId)},"at":${Date.now()}}\n\n`)

  ping = setInterval(() => {
    if (subscriber.closed) return
    void (async () => {
      if (subscriber.authorize) {
        try {
          if (!(await subscriber.authorize())) { subscriber.revoke(); return }
        } catch {
          subscriber.revoke()
          return
        }
      }
      try { res.write(`: ping ${Date.now()}\n\n`) } catch { subscriber.revoke() }
    })()
  }, 25_000)
  ping.unref?.()
}
