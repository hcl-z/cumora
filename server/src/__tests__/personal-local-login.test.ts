/**
 * The local login link is a bearer credential for the whole deployment, so
 * the boot gate and the token rules carry the security of T02. Pure module:
 * no env, pool or redis is loaded here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isLoopbackHost,
  localLoginConfigErrors,
  localLoginUrl,
  LocalLoginTokens,
  LOCAL_LOGIN_TTL_MS,
} from '../personal/local-login.js'

const safe = { enabled: true, personalMode: true, nodeEnv: 'development', listenHost: '127.0.0.1' }

test('only literal loopback addresses count as loopback', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', ' 127.0.0.1 ']) assert.equal(isLoopbackHost(h), true, h)
  for (const h of ['', 'localhost', '0.0.0.0', '::', '192.168.1.2', '127.0.0.1.evil', '1270.0.0.1']) {
    assert.equal(isLoopbackHost(h), false, h)
  }
})

test('the boot gate is silent when local login is off', () => {
  assert.deepEqual(localLoginConfigErrors({ ...safe, enabled: false, personalMode: false, nodeEnv: 'production', listenHost: '' }), [])
})

test('the boot gate accepts personal mode, non-production and a loopback listener', () => {
  assert.deepEqual(localLoginConfigErrors(safe), [])
})

test('the boot gate refuses every unsafe combination', () => {
  assert.equal(localLoginConfigErrors({ ...safe, personalMode: false }).length, 1)
  assert.equal(localLoginConfigErrors({ ...safe, nodeEnv: 'production' }).length, 1)
  assert.equal(localLoginConfigErrors({ ...safe, listenHost: '' }).length, 1)
  assert.equal(localLoginConfigErrors({ ...safe, listenHost: '0.0.0.0' }).length, 1)
  assert.equal(localLoginConfigErrors({ ...safe, listenHost: 'localhost' }).length, 1)
  assert.equal(localLoginConfigErrors({ enabled: true, personalMode: false, nodeEnv: 'production', listenHost: '' }).length, 3)
})

test('a token is accepted once, then never again', () => {
  const tokens = new LocalLoginTokens()
  const t = tokens.issue()
  assert.equal(tokens.consume(t), true)
  assert.equal(tokens.consume(t), false)
})

test('a token expires after the TTL', () => {
  let now = 1_000
  const tokens = new LocalLoginTokens(() => now)
  const t = tokens.issue()
  now += LOCAL_LOGIN_TTL_MS
  assert.equal(tokens.consume(t), false)
  // Expiry also retires the token, so the clock going back does not revive it.
  now -= 1
  assert.equal(tokens.consume(t), false)
})

test('a wrong token is refused without burning the real one', () => {
  const tokens = new LocalLoginTokens()
  const t = tokens.issue()
  assert.equal(tokens.consume(''), false)
  assert.equal(tokens.consume('short'), false)
  assert.equal(tokens.consume(`${t.slice(0, -2)}AA`), false)
  assert.equal(tokens.consume(t), true)
})

test('issuing a new token retires the previous one', () => {
  const tokens = new LocalLoginTokens()
  const first = tokens.issue()
  const second = tokens.issue()
  assert.notEqual(first, second)
  assert.equal(tokens.consume(first), false)
  assert.equal(tokens.consume(second), true)
})

test('the login link carries the token in the fragment, never the query', () => {
  const url = localLoginUrl('http://localhost:5180/', 'abc-_123')
  assert.equal(url, 'http://localhost:5180/#login=abc-_123')
  assert.equal(new URL(url).search, '')
  assert.equal(localLoginUrl('http://localhost:5180/#old', 'x'), 'http://localhost:5180/#login=x')
})
