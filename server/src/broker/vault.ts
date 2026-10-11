/**
 * The daemon's credential vault (docs/personal-bot/mvp-backend-design.md §7).
 * Plaintext credentials exist only here: in memory, and AES-256-GCM-encrypted
 * in a 0600 file. The server and the model only ever know credential names.
 *
 * - Master key (32 bytes): CUMORA_VAULT_MASTER_KEY_FILE, else the Docker
 *   secret /run/secrets/vault_master_key, else the macOS keychain (created on
 *   first use, written through `security -i` so it never appears in argv),
 *   else a 0600 file beside the vault with a one-time warning. Never read
 *   from or written to an environment variable or a log.
 * - ECDH P-256 keypair: the browser seals a credential to its public key
 *   (src/lib/vault-seal.ts); the private key is stored encrypted under the
 *   master key.
 * - Each entry is encrypted with AAD `<connector>\0<name>`, so a ciphertext
 *   cannot be moved to another connector or name.
 *
 * Dependency-free (node: built-ins only) for the daemon bundle.
 */
import { spawnSync } from 'node:child_process'
import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync,
  hkdfSync, type JsonWebKey, type KeyObject, randomBytes,
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CREDENTIAL_NAME_RE } from './definition.js'

export { CREDENTIAL_NAME_RE }
export const VAULT_FORMAT = 'cumora-vault'
export const VAULT_VERSION = 1
export const SEAL_INFO = 'cumora-vault-v1'
const KEYCHAIN_SERVICE = 'cumora-vault-master-key'
const DOCKER_SECRET = '/run/secrets/vault_master_key'
const MAX_VALUE_BYTES = 16 * 1024

export class VaultError extends Error {
  constructor(message: string, readonly code: 'bad_seal' | 'bad_key' | 'not_found' | 'invalid' | 'io') {
    super(message)
    this.name = 'VaultError'
  }
}

/** A sealed credential as produced by src/lib/vault-seal.ts. */
export interface SealedCredential { v: 1; epk: JsonWebKey; iv: string; ct: string }

interface Box { iv: string; tag: string; ct: string }
interface Entry extends Box { connector: string; name: string; created_at: string; updated_at: string }
interface VaultFile {
  format: string
  version: number
  ecdh: Box & { pub: JsonWebKey }
  entries: Entry[]
}

// ── master key ─────────────────────────────────────────────────────────

export interface MasterKeySource {
  /** Where the key came from, for the startup log (never the key itself). */
  label: string
  load(): Buffer
}

function decodeKey(raw: string, where: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64')
  if (key.length !== 32) throw new VaultError(`${where} does not hold a 32-byte base64 key`, 'bad_key')
  return key
}

function fileKeySource(path: string, create: boolean): MasterKeySource {
  return {
    label: `file ${path}`,
    load() {
      if (!existsSync(path)) {
        if (!create) throw new VaultError(`master key file ${path} does not exist`, 'bad_key')
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        writeFileSync(path, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
      }
      return decodeKey(readFileSync(path, 'utf8'), path)
    },
  }
}

function keychainSource(): MasterKeySource {
  return {
    label: 'macOS keychain',
    load() {
      const found = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'cumora', '-w'], { encoding: 'utf8' })
      if (found.status === 0 && found.stdout.trim()) return decodeKey(found.stdout, 'the keychain item')
      const key = randomBytes(32).toString('base64')
      // `security -i` reads the command from stdin, so the key is never in argv.
      const added = spawnSync('security', ['-i'], {
        input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a cumora -w ${key}\n`,
        encoding: 'utf8',
      })
      if (added.status !== 0) throw new VaultError('could not store the vault master key in the macOS keychain', 'bad_key')
      return Buffer.from(key, 'base64')
    },
  }
}

/** Pick the master key source for this machine (see the module comment). */
export function defaultMasterKeySource(configDir: string, env: NodeJS.ProcessEnv = process.env): MasterKeySource {
  const explicit = (env.CUMORA_VAULT_MASTER_KEY_FILE ?? '').trim()
  if (explicit) return fileKeySource(explicit, false)
  if (existsSync(DOCKER_SECRET)) return fileKeySource(DOCKER_SECRET, false)
  if (process.platform === 'darwin' && spawnSync('security', ['help'], { stdio: 'ignore' }).error === undefined) return keychainSource()
  const fallback = fileKeySource(join(configDir, 'vault.key'), true)
  return { label: `${fallback.label} (no keychain on this machine; protect this file)`, load: fallback.load }
}

// ── AES-GCM boxes ──────────────────────────────────────────────────────

function seal(key: Buffer, plaintext: Buffer, aad: string): Box {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') }
}

function open(key: Buffer, box: Box, aad: string): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()])
  } catch {
    throw new VaultError('a vault entry failed to decrypt (wrong master key, or the file was altered)', 'bad_key')
  }
}

// ── redaction ──────────────────────────────────────────────────────────

/** Replaces every known credential value (raw, URL-encoded and base64) with
 *  `[REDACTED:<name>]`. Values shorter than 6 characters are not matched:
 *  they would turn ordinary text into redactions. */
export class Redactor {
  private needles: Array<{ value: string; label: string }> = []

  set(secrets: Array<{ name: string; value: string }>): void {
    const out: Array<{ value: string; label: string }> = []
    for (const { name, value } of secrets) {
      if (value.length < 6) continue
      const label = `[REDACTED:${name}]`
      for (const v of new Set([value, encodeURIComponent(value), Buffer.from(value).toString('base64')])) out.push({ value: v, label })
    }
    // Longest first, so a value that contains another is replaced whole.
    this.needles = out.sort((a, b) => b.value.length - a.value.length)
  }

  redact(text: string): string {
    let result = text
    for (const n of this.needles) if (result.includes(n.value)) result = result.split(n.value).join(n.label)
    return result
  }

  /** Redact every string inside a JSON-shaped value. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.redactDeep(v)])) as T
    }
    return value
  }
}

// ── the vault ──────────────────────────────────────────────────────────

export interface CredentialInfo { connector: string; name: string; updatedAt: string }

export class Vault {
  private master: Buffer | null = null
  private file: VaultFile | null = null
  private loadedMtimeMs = -1
  readonly redactor = new Redactor()

  constructor(private readonly path: string, private readonly keySource: MasterKeySource) {}

  get keyLabel(): string { return this.keySource.label }

  private key(): Buffer {
    if (!this.master) this.master = this.keySource.load()
    return this.master
  }

  /** Load the file (or create it with a fresh ECDH keypair). Re-reads when
   *  another process (the `vault set` CLI) changed it. */
  private load(): VaultFile {
    const mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : -1
    if (this.file && mtime === this.loadedMtimeMs) return this.file
    if (mtime < 0) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const der = privateKey.export({ format: 'der', type: 'pkcs8' })
      this.file = {
        format: VAULT_FORMAT, version: VAULT_VERSION,
        ecdh: { ...seal(this.key(), der, 'ecdh'), pub: publicKey.export({ format: 'jwk' }) },
        entries: [],
      }
      this.write(this.file)
    } else {
      let parsed: VaultFile
      try { parsed = JSON.parse(readFileSync(this.path, 'utf8')) as VaultFile } catch {
        throw new VaultError(`${this.path} is not valid JSON`, 'io')
      }
      if (parsed.format !== VAULT_FORMAT || parsed.version !== VAULT_VERSION) throw new VaultError(`${this.path} is not a v1 vault`, 'io')
      this.file = parsed
      this.loadedMtimeMs = statSync(this.path).mtimeMs
    }
    this.refreshRedactor()
    return this.file
  }

  private write(file: VaultFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
    chmodSync(this.path, 0o600)
    this.loadedMtimeMs = statSync(this.path).mtimeMs
  }

  private privateKey(): KeyObject {
    const f = this.load()
    return createPrivateKey({ key: open(this.key(), f.ecdh, 'ecdh'), format: 'der', type: 'pkcs8' })
  }

  /** The P-256 public key the browser seals credentials to. */
  publicKeyJwk(): JsonWebKey {
    const { kty, crv, x, y } = this.load().ecdh.pub
    return { kty, crv, x, y }
  }

  list(): CredentialInfo[] {
    return this.load().entries.map((e) => ({ connector: e.connector, name: e.name, updatedAt: e.updated_at }))
  }

  /** The plaintext for one credential, or null. */
  get(connector: string, name: string): string | null {
    const e = this.load().entries.find((x) => x.connector === connector && x.name === name)
    return e ? open(this.key(), e, `${connector}\0${name}`).toString('utf8') : null
  }

  put(connector: string, name: string, value: string): CredentialInfo {
    if (!CREDENTIAL_NAME_RE.test(name)) throw new VaultError(`invalid credential name: ${name}`, 'invalid')
    if (!connector || connector.length > 64) throw new VaultError('invalid connector', 'invalid')
    if (!value || Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new VaultError('a credential must be 1 byte to 16KB', 'invalid')
    const f = this.load()
    const now = new Date().toISOString()
    const box = seal(this.key(), Buffer.from(value, 'utf8'), `${connector}\0${name}`)
    const existing = f.entries.find((x) => x.connector === connector && x.name === name)
    const entry: Entry = { connector, name, ...box, created_at: existing?.created_at ?? now, updated_at: now }
    f.entries = [...f.entries.filter((x) => x !== existing), entry]
    this.write(f)
    this.refreshRedactor()
    return { connector, name, updatedAt: now }
  }

  remove(connector: string, name: string): boolean {
    const f = this.load()
    const before = f.entries.length
    f.entries = f.entries.filter((x) => !(x.connector === connector && x.name === name))
    if (f.entries.length === before) return false
    this.write(f)
    this.refreshRedactor()
    return true
  }

  /** Decrypt a browser-sealed credential and check it was sealed for this
   *  connector and name (the server only relays it and could swap them). */
  unseal(sealed: SealedCredential, expect: { connector: string; name: string }): string {
    if (!sealed || sealed.v !== 1 || !sealed.epk || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') {
      throw new VaultError('not a v1 sealed credential', 'bad_seal')
    }
    let plain: { connector?: unknown; name?: unknown; value?: unknown }
    try {
      const epk = createPublicKey({ key: sealed.epk, format: 'jwk' })
      const shared = diffieHellman({ privateKey: this.privateKey(), publicKey: epk })
      const aes = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(32), Buffer.from(SEAL_INFO), 32))
      const raw = Buffer.from(sealed.ct, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', aes, Buffer.from(sealed.iv, 'base64'))
      decipher.setAuthTag(raw.subarray(raw.length - 16))
      plain = JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8'))
    } catch {
      throw new VaultError('the sealed credential could not be opened with this computer\'s key', 'bad_seal')
    }
    if (plain.connector !== expect.connector || plain.name !== expect.name || typeof plain.value !== 'string') {
      throw new VaultError('the sealed credential was made for a different connector or name', 'bad_seal')
    }
    return plain.value
  }

  private refreshRedactor(): void {
    const f = this.file
    if (!f) return
    const secrets: Array<{ name: string; value: string }> = []
    for (const e of f.entries) {
      try { secrets.push({ name: e.name, value: open(this.key(), e, `${e.connector}\0${e.name}`).toString('utf8') }) } catch { /* surfaced on use */ }
    }
    this.redactor.set(secrets)
  }
}

/** Seal exactly as src/lib/vault-seal.ts does in the browser: an ephemeral
 *  P-256 key, ECDH with the daemon's key, HKDF-SHA256 (32 zero bytes of
 *  salt, info "cumora-vault-v1"), AES-256-GCM with the tag appended. Used by
 *  tests and e2e to stand in for the browser. */
export function sealCredential(pub: JsonWebKey, plaintext: { connector: string; name: string; value: string }): SealedCredential {
  const eph = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: pub, format: 'jwk' }) })
  const aes = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(32), Buffer.from(SEAL_INFO), 32))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aes, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plaintext))), cipher.final(), cipher.getAuthTag()])
  const { kty, crv, x, y } = eph.publicKey.export({ format: 'jwk' })
  return { v: 1, epk: { kty, crv, x, y }, iv: iv.toString('base64'), ct: ct.toString('base64') }
}
