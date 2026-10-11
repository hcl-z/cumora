/**
 * The bootstrap secret lets the bundled daemon pair itself into the owner's
 * workspace, so its rules are pinned here: a short secret refuses to boot and
 * the comparison accepts only an exact match.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bootstrapTokenError,
  bootstrapTokenMatches,
  MIN_BOOTSTRAP_TOKEN_LENGTH,
} from '../personal/bootstrap-token.js'

const good = 'a'.repeat(MIN_BOOTSTRAP_TOKEN_LENGTH)

test('an unset secret disables bootstrap pairing without blocking boot', () => {
  assert.equal(bootstrapTokenError(''), null)
})

test('a secret shorter than the minimum refuses to boot', () => {
  assert.match(bootstrapTokenError(good.slice(1)) ?? '', /at least 32/)
  assert.equal(bootstrapTokenError(good), null)
})

test('only the exact secret matches', () => {
  assert.equal(bootstrapTokenMatches(good, good), true)
  assert.equal(bootstrapTokenMatches(good, `${good}x`), false)
  assert.equal(bootstrapTokenMatches(good, good.slice(1)), false)
  assert.equal(bootstrapTokenMatches(good, ''), false)
  // An unconfigured server must never accept anything, not even an empty token.
  assert.equal(bootstrapTokenMatches('', ''), false)
})
