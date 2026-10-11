/**
 * The daemon's credential vault (task T09): the browser's seal format opens
 * here and only for the connector and name it was made for, entries survive
 * a reload and refuse a different master key, the file is 0600, another
 * process's write is picked up, and redaction covers raw, URL-encoded and
 * base64 forms.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Redactor, Vault, VaultError, defaultMasterKeySource, sealCredential, type MasterKeySource } from '../broker/vault.js'

let dir: string
before(async () => { dir = await mkdtemp(join(tmpdir(), 'vault-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

const keyOf = (bytes: Buffer): MasterKeySource => ({ label: 'test', load: () => bytes })
const fresh = (name: string, key = randomBytes(32)) => ({ vault: new Vault(join(dir, `${name}.json`), keyOf(key)), key })

test('a browser-sealed credential opens only for its connector and name', () => {
  const { vault } = fresh('seal')
  const pub = vault.publicKeyJwk()
  assert.deepEqual(Object.keys(pub).sort(), ['crv', 'kty', 'x', 'y'])
  const sealed = sealCredential(pub, { connector: 'market-data', name: 'api-key', value: 'sk-live-123456' })
  assert.equal(vault.unseal(sealed, { connector: 'market-data', name: 'api-key' }), 'sk-live-123456')
  // The server only relays the blob; it cannot retarget it.
  assert.throws(() => vault.unseal(sealed, { connector: 'other', name: 'api-key' }), /different connector or name/)
  assert.throws(() => vault.unseal(sealed, { connector: 'market-data', name: 'other' }), /different connector or name/)
  // Sealed to another computer's key, or tampered with: refused.
  const elsewhere = fresh('elsewhere').vault
  assert.throws(() => elsewhere.unseal(sealed, { connector: 'market-data', name: 'api-key' }), VaultError)
  const tampered = { ...sealed, ct: Buffer.from(Buffer.from(sealed.ct, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') }
  assert.throws(() => vault.unseal(tampered, { connector: 'market-data', name: 'api-key' }), /could not be opened/)
  assert.throws(() => vault.unseal({ v: 2 } as never, { connector: 'market-data', name: 'api-key' }), /not a v1 sealed credential/)
})

test('entries persist encrypted in a 0600 file and need the same master key', async () => {
  const { vault, key } = fresh('persist')
  vault.put('market-data', 'api-key', 'sk-live-abcdef')
  const path = join(dir, 'persist.json')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const raw = await readFile(path, 'utf8')
  assert.doesNotMatch(raw, /sk-live-abcdef/)
  assert.doesNotMatch(raw, /"d"\s*:/, 'the ECDH private key is not stored in the clear')

  const reopened = new Vault(path, keyOf(key))
  assert.equal(reopened.get('market-data', 'api-key'), 'sk-live-abcdef')
  assert.deepEqual(reopened.list().map((c) => [c.connector, c.name]), [['market-data', 'api-key']])
  assert.deepEqual(reopened.publicKeyJwk(), vault.publicKeyJwk(), 'the keypair survives a restart')

  const wrongKey = new Vault(path, keyOf(randomBytes(32)))
  assert.throws(() => wrongKey.get('market-data', 'api-key'), /wrong master key/)

  // An entry cannot be copied under another name: the AAD binds it.
  const file = JSON.parse(raw)
  file.entries[0].name = 'stolen'
  await writeFile(path, JSON.stringify(file))
  assert.throws(() => new Vault(path, keyOf(key)).get('market-data', 'stolen'), /failed to decrypt/)
})

test('a write by another process (the vault set CLI) is picked up', async () => {
  const { vault, key } = fresh('shared')
  const path = join(dir, 'shared.json')
  assert.equal(vault.get('c', 'k1'), null)
  await new Promise((r) => setTimeout(r, 15))
  new Vault(path, keyOf(key)).put('c', 'k1', 'value-from-cli')
  assert.equal(vault.get('c', 'k1'), 'value-from-cli')
  assert.equal(vault.redactor.redact('echo value-from-cli'), 'echo [REDACTED:k1]')
  assert.equal(vault.remove('c', 'k1'), true)
  assert.equal(vault.get('c', 'k1'), null)
  assert.equal(vault.redactor.redact('echo value-from-cli'), 'echo value-from-cli')
})

test('names and values are validated', () => {
  const { vault } = fresh('validate')
  assert.throws(() => vault.put('c', 'Bad Name', 'v'), /invalid credential name/)
  assert.throws(() => vault.put('c', 'ok', ''), /1 byte to 16KB/)
  assert.throws(() => vault.put('c', 'ok', 'x'.repeat(17 * 1024)), /1 byte to 16KB/)
})

test('redaction covers raw, URL-encoded and base64 forms, longest first', () => {
  const r = new Redactor()
  r.set([{ name: 'key', value: 'abc+def/ghi=' }, { name: 'short', value: 'abc' }, { name: 'long', value: 'abc+def/ghi=EXTRA' }])
  assert.equal(r.redact('raw abc+def/ghi=EXTRA here'), 'raw [REDACTED:long] here')
  assert.equal(r.redact(`q=${encodeURIComponent('abc+def/ghi=')}`), 'q=[REDACTED:key]')
  assert.equal(r.redact(Buffer.from('abc+def/ghi=').toString('base64')), '[REDACTED:key]')
  assert.equal(r.redact('abc stays'), 'abc stays', 'values under 6 characters are not matched')
  assert.deepEqual(r.redactDeep({ a: ['x abc+def/ghi= y', 3], b: { c: 'abc+def/ghi=' } }), { a: ['x [REDACTED:key] y', 3], b: { c: '[REDACTED:key]' } })
})

test('the browser seal (WebCrypto, src/lib/vault-seal.ts) opens in the daemon vault', async () => {
  const { sealCredential: browserSeal } = await import('../../../src/lib/vault-seal.js')
  const { vault } = fresh('browser')
  const sealed = await browserSeal(vault.publicKeyJwk(), { connector: 'market-data', name: 'api-key', value: 'from-the-browser-✓' })
  assert.equal(sealed.v, 1)
  assert.equal(vault.unseal(sealed, { connector: 'market-data', name: 'api-key' }), 'from-the-browser-✓')
})

test('an explicit master key file is used and never created', async () => {
  const keyFile = join(dir, 'master.key')
  assert.throws(() => defaultMasterKeySource(dir, { CUMORA_VAULT_MASTER_KEY_FILE: keyFile }).load(), /does not exist/)
  await writeFile(keyFile, randomBytes(32).toString('base64'))
  const source = defaultMasterKeySource(dir, { CUMORA_VAULT_MASTER_KEY_FILE: keyFile })
  assert.equal(source.load().length, 32)
  assert.match(source.label, /master\.key/)
  await writeFile(keyFile, 'too-short')
  assert.throws(() => source.load(), /32-byte base64 key/)
})
