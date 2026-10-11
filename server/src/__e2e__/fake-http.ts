/**
 * A fixture HTTP service for connector e2e tests (T08 onward): each route
 * answers with a canned status and JSON body, and every request is kept so a
 * test can assert what the Broker actually sent (method, path, query,
 * headers, body). Unknown routes answer 404 and are recorded too.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRoute {
  method: string
  path: string
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Delay before answering, for timeout tests. */
  delayMs?: number
}

export interface FakeHttpRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string | string[] | undefined>
  body: string
}

export class FakeHttp {
  readonly requests: FakeHttpRequest[] = []
  private server: Server | null = null
  baseUrl = ''

  constructor(private routes: FakeRoute[] = []) {}

  route(r: FakeRoute): void { this.routes.push(r) }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://fake')
        const body = await readBody(req)
        this.requests.push({
          method: req.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body,
        })
        const r = this.routes.find((x) => x.method.toUpperCase() === req.method && x.path === url.pathname)
        if (!r) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no fixture route' }))
          return
        }
        if (r.delayMs) await new Promise((done) => setTimeout(done, r.delayMs))
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...r.headers })
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}))
      })()
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    return this.baseUrl
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
