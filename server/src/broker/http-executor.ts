/**
 * Executes one declarative HTTP connector call for the daemon's Broker
 * (docs/personal-bot/mvp-backend-design.md §6.1).
 *
 * The boundary, not a convenience: https only; every address the host
 * resolves to is checked against isPrivateAddress inside the socket's own
 * lookup, so the address that is checked is the address that is dialled (no
 * DNS rebinding between check and connect); redirects are not followed; 30s
 * per call; the response is cut off past 2MB; a token bucket per connector.
 *
 * Dependency-free (node: built-ins only) so the daemon bundle stays small.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { type ConnectorAction, type ConnectorDefinition, buildRequest, isLoopbackAddress, isPrivateAddress } from './definition.js'

export const HTTP_TIMEOUT_MS = 30_000
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export class ConnectorCallError extends Error {
  constructor(message: string, readonly reason: 'blocked' | 'timeout' | 'too_large' | 'rate_limited' | 'network') {
    super(message)
    this.name = 'ConnectorCallError'
  }
}

export interface HttpResult {
  status: number
  contentType: string | null
  body: Buffer
  durationMs: number
}

export interface ExecuteOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  /** Allow plain http to a loopback literal (local e2e only). Every other
   *  private address stays blocked even then. */
  allowLoopbackHttp?: boolean
  /** Test seam for DNS. */
  resolve?: (host: string) => Promise<LookupAddress[]>
}

/** Token bucket per connector: `perMinute` calls, refilled continuously. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, perMinute: number): boolean {
    const t = this.now()
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: t }
    const tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute)
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: t })
      return false
    }
    this.buckets.set(key, { tokens: tokens - 1, at: t })
    return true
  }
}

function systemResolve(host: string): Promise<LookupAddress[]> {
  return new Promise((done, fail) => dnsLookup(host, { all: true }, (err, addrs) => (err ? fail(err) : done(addrs))))
}

/** A socket lookup that refuses to hand back any blocked address. */
function guardedLookup(resolve: (host: string) => Promise<LookupAddress[]>, allowLoopback: boolean): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then((addrs) => {
      const bad = addrs.find((a) => isPrivateAddress(a.address) && !(allowLoopback && isLoopbackAddress(a.address)))
      if (!addrs.length) return callback(new ConnectorCallError(`${hostname} did not resolve`, 'network'))
      if (bad) return callback(new ConnectorCallError(`${hostname} resolves to a private address (${bad.address}); connectors may only reach public hosts`, 'blocked'))
      if (options?.all) callback(null, addrs)
      else callback(null, addrs[0].address, addrs[0].family)
    }, (err: Error) => callback(new ConnectorCallError(`could not resolve ${hostname}: ${err.message}`, 'network')))
  }) as unknown as LookupFunction
}

/** Reject a URL before any socket is opened. Exported for tests. */
export function checkUrl(url: URL, allowLoopbackHttp: boolean): void {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(host) !== 0
  const loopbackLiteral = literal && isLoopbackAddress(host)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopbackHttp && loopbackLiteral)) {
    throw new ConnectorCallError(`${url.protocol.replace(':', '')} is not allowed; connectors must use https`, 'blocked')
  }
  if (url.username || url.password) throw new ConnectorCallError('URLs with embedded credentials are not allowed', 'blocked')
  if (literal && isPrivateAddress(host) && !(allowLoopbackHttp && loopbackLiteral)) {
    throw new ConnectorCallError(`${host} is a private address; connectors may only reach public hosts`, 'blocked')
  }
  if (!literal && /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new ConnectorCallError(`${host} is a local hostname; connectors may only reach public hosts`, 'blocked')
  }
}

export async function executeHttp(
  def: ConnectorDefinition,
  action: ConnectorAction,
  args: Record<string, unknown>,
  opts: ExecuteOptions = {},
): Promise<HttpResult> {
  const built = buildRequest(def, action, args)
  const allowLoopback = opts.allowLoopbackHttp === true
  checkUrl(built.url, allowLoopback)
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES
  const t0 = Date.now()
  const send = built.url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise<HttpResult>((done, fail) => {
    let settled = false
    const finish = (err: Error | null, value?: HttpResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (err) fail(err)
      else done(value!)
    }
    const req = send(built.url, {
      method: built.method,
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        'User-Agent': 'cumora-broker/1',
        ...(built.body !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(built.body) } : {}),
      },
      lookup: guardedLookup(opts.resolve ?? systemResolve, allowLoopback),
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      let size = 0
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy()
        req.destroy()
        return finish(new ConnectorCallError(`response is ${declared} bytes, over the ${maxBytes}-byte limit`, 'too_large'))
      }
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          res.destroy()
          req.destroy()
          finish(new ConnectorCallError(`response exceeded the ${maxBytes}-byte limit`, 'too_large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => finish(null, {
        status: res.statusCode ?? 0,
        contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null,
        body: Buffer.concat(chunks),
        durationMs: Date.now() - t0,
      }))
      res.on('error', (err) => finish(err instanceof ConnectorCallError ? err : new ConnectorCallError(err.message, 'network')))
    })
    const timer = setTimeout(() => {
      req.destroy()
      finish(new ConnectorCallError(`no complete response within ${timeoutMs}ms`, 'timeout'))
    }, timeoutMs)
    const onAbort = () => {
      req.destroy()
      finish(new ConnectorCallError('call cancelled', 'network'))
    }
    if (opts.signal?.aborted) return onAbort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', (err) => finish(err instanceof ConnectorCallError ? err : new ConnectorCallError(err.message, 'network')))
    if (built.body !== null) req.write(built.body)
    req.end()
  })
}
