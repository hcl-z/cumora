/**
 * Boots a whole personal-mode stack for one e2e run: a fresh database, the
 * server, a fake OpenAI both the server and the daemon talk to, and a daemon
 * that bootstrap-pairs itself under a throwaway HOME, so nothing touches the
 * developer's ~/.cumora.
 *
 * Needs Postgres and Redis. DATABASE_URL must name a database ending in
 * `_e2e`: its public schema is dropped on every start.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { FakeOpenAI, type Cassette } from './fake-openai.js'

const ROOT = resolve(import.meta.dirname, '../../..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL
  ?? `postgres://${process.env.USER ?? 'postgres'}@localhost:5432/cumora_e2e`
export const E2E_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

/** Why the stack cannot start here, or null. Lets a test skip, not hang. */
export async function stackUnavailableReason(): Promise<string | null> {
  const redis = new URL(E2E_REDIS_URL)
  const reachable = await new Promise<boolean>((done) => {
    const sock = connect({ host: redis.hostname, port: Number(redis.port || 6379) })
    sock.setTimeout(1500)
    sock.once('connect', () => { sock.destroy(); done(true) })
    sock.once('error', () => done(false))
    sock.once('timeout', () => { sock.destroy(); done(false) })
  })
  if (!reachable) return `Redis is not reachable at ${E2E_REDIS_URL}`
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL })
  try {
    await client.connect()
  } catch (err) {
    return `Postgres is not reachable at ${E2E_DATABASE_URL}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    await client.end().catch(() => {})
  }
  return null
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer()
    srv.once('error', fail)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => done(port))
    })
  })
}

async function resetDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1)
  if (!name.endsWith('_e2e')) throw new Error(`refusing to reset ${name}: the e2e database name must end in _e2e`)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('DROP SCHEMA public CASCADE')
    await client.query('CREATE SCHEMA public')
  } finally {
    await client.end()
  }
}

class Proc {
  readonly lines: string[] = []
  private waiters: Array<{ re: RegExp; done: (m: RegExpMatchArray) => void }> = []
  readonly exited: Promise<number | null>

  constructor(readonly name: string, readonly child: ChildProcess) {
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line) continue
        this.lines.push(line)
        if (process.env.E2E_VERBOSE) console.log(`[${name}] ${line}`)
        this.waiters = this.waiters.filter((w) => {
          const m = line.match(w.re)
          if (m) w.done(m)
          return !m
        })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    this.exited = new Promise((done) => child.once('exit', (code) => done(code)))
  }

  waitFor(re: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
    for (const line of this.lines) {
      const m = line.match(re)
      if (m) return Promise.resolve(m)
    }
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${this.name}: no line matching ${re} within ${timeoutMs}ms`)), timeoutMs)
      this.waiters.push({ re, done: (m) => { clearTimeout(timer); done(m) } })
      void this.exited.then((code) => { clearTimeout(timer); fail(new Error(`${this.name} exited (${code}) before ${re}`)) })
    })
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000)
    await this.exited
    clearTimeout(timer)
  }
}

function run(name: string, args: string[], env: NodeJS.ProcessEnv): Proc {
  return new Proc(name, spawn(TSX, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }))
}

export interface Stack {
  serverUrl: string
  openai: FakeOpenAI
  token: string
  companyId: string
  server: Proc
  daemon: Proc
  /** Authenticated JSON call against /api as the owner. */
  api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T>
  /** Write both processes' logs to `path` (CI uploads them on failure). */
  dumpLogs(path: string): Promise<void>
  stop(): Promise<void>
}

export async function startStack(opts: { cassette: Cassette }): Promise<Stack> {
  const openai = new FakeOpenAI({ cassette: opts.cassette })
  const openaiUrl = await openai.start()
  const port = await freePort()
  const serverUrl = `http://127.0.0.1:${port}`
  const bootstrapToken = randomBytes(24).toString('hex')
  const home = await mkdtemp(join(tmpdir(), 'cumora-e2e-home-'))

  const common: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    // A dummy key: every model call goes to the fake.
    OPENAI_API_KEY: 'sk-e2e-fake',
    OPENAI_BASE_URL: openaiUrl,
    NODE_ENV: 'test',
  }
  const serverEnv: NodeJS.ProcessEnv = {
    ...common,
    HOME: home,
    DATABASE_URL: E2E_DATABASE_URL,
    REDIS_URL: E2E_REDIS_URL,
    PORT: String(port),
    LISTEN_HOST: '127.0.0.1',
    PERSONAL_MODE: '1',
    PERSONAL_LOCAL_LOGIN: '1',
    PERSONAL_BOOTSTRAP_TOKEN: bootstrapToken,
    CUMORA_AUTH_DONE_URL: `${serverUrl}/`,
    AUTH_SECRET: 'e2e-auth-secret',
    EMAIL_DOMAIN: 'cumora.local',
    EMAIL_INBOUND_HMAC_SECRET: 'e2e-secret',
    RESEND_API_KEY: '',
  }

  await resetDatabase(E2E_DATABASE_URL)
  const migrate = run('migrate', ['server/src/migrate-bin.ts'], serverEnv)
  const migrateCode = await migrate.exited
  if (migrateCode !== 0) throw new Error(`migrate failed (${migrateCode}):\n${migrate.lines.slice(-30).join('\n')}`)

  const server = run('server', ['server/src/index.ts'], serverEnv)
  let daemon: Proc | null = null
  const stop = async () => {
    await daemon?.stop()
    await server.stop()
    await openai.stop()
    await rm(home, { recursive: true, force: true })
  }
  try {
    const login = await server.waitFor(/one-time login[^:]*:\s*\S*#login=([A-Za-z0-9_-]+)/, 60_000)
    const res = await fetch(`${serverUrl}/api/auth/local-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: login[1] }),
    })
    if (!res.ok) throw new Error(`local login failed: HTTP ${res.status} ${await res.text()}`)
    const { token, companyId } = await res.json() as { token: string; companyId: string }

    daemon = run('daemon', ['server/src/cli-bin.ts', 'agent', 'computer', '--server', serverUrl], {
      ...common,
      HOME: home,
      CUMORA_PERSONAL_BOOTSTRAP_TOKEN: bootstrapToken,
    })

    const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const r = await fetch(`${serverUrl}/api${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-company-id': companyId,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
      if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${r.status} ${await r.text()}`)
      return await r.json() as T
    }

    const d = daemon
    return {
      serverUrl, openai, token, companyId, server, daemon: d, api, stop,
      dumpLogs: async (path) => {
        const section = (p: Proc) => `===== ${p.name} =====\n${p.lines.join('\n')}\n`
        const requests = `===== fake-openai =====\n${JSON.stringify({ received: openai.received, unmatched: openai.unmatched }, null, 2)}\n`
        await writeFile(path, section(server) + section(d) + requests)
      },
    }
  } catch (err) {
    if (process.env.E2E_VERBOSE !== '1') {
      console.error(`[e2e] stack failed to start; last server lines:\n${server.lines.slice(-40).join('\n')}`)
      if (daemon) console.error(`[e2e] last daemon lines:\n${daemon.lines.slice(-40).join('\n')}`)
    }
    await stop()
    throw err
  }
}

/** Poll `probe` until it returns a value, or fail after `timeoutMs`. */
export async function eventually<T>(probe: () => Promise<T | null | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const v = await probe()
      if (v !== null && v !== undefined) return v
    } catch (err) {
      lastError = err
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ''}`)
}
