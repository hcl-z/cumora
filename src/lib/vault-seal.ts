/**
 * Seal a credential in the browser for the bot host's vault
 * (docs/personal-bot/mvp-frontend-design.md §5.3). Only the daemon's ECDH
 * private key opens it, so the server that relays it never sees the value.
 *
 * Must stay byte-compatible with server/src/broker/vault.ts (`unseal`,
 * `sealCredential`): ephemeral P-256 ECDH, HKDF-SHA256 with 32 zero bytes of
 * salt and info "cumora-vault-v1", AES-256-GCM (tag appended by WebCrypto).
 * The plaintext names its connector and credential so the server cannot
 * retarget a sealed value.
 */

/** The public P-256 JWK fields (DOM's JsonWebKey, kept local so the server's
 *  Node-only type check can import this file in the compatibility test). */
export interface EcPublicJwk { kty?: string; crv?: string; x?: string; y?: string; [field: string]: unknown }

export interface SealedCredential { v: 1; epk: EcPublicJwk; iv: string; ct: string }

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** WebCrypto exists only in secure contexts (https, localhost, Electron,
 *  Capacitor). Plain-http LAN access cannot seal. */
export function canSeal(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.deriveBits === 'function'
}

export async function sealCredential(
  daemonPubJwk: EcPublicJwk,
  plaintext: { connector: string; name: string; value: string },
): Promise<SealedCredential> {
  const daemonKey = await crypto.subtle.importKey('jwk', daemonPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: daemonKey }, eph.privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('cumora-vault-v1') },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(plaintext)))
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', eph.publicKey)
  return { v: 1, epk: { kty, crv, x, y }, iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}
