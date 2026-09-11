/**
 * crypto.ts — WinterCG-safe HMAC for the connector core (plan L-N8): Web
 * Crypto (globalThis.crypto.subtle) only, no node:crypto — the same code
 * must run on Node >=20, Vercel Edge, and any fetch-runtime host. All
 * Node-specific code stays in handlers/adapters, never here.
 *
 * HONESTY / security: the site key never appears in any thrown error or log;
 * comparisons are constant-time.
 */

const encoder = new TextEncoder();

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    // Bounded: a connector holds exactly one key in practice; cap defensively.
    if (keyCache.size > 4) keyCache.clear();
    keyCache.set(secret, cached);
  }
  return cached;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 over `message`, keyed by `secret`, hex-encoded — the wire signature format shared with the engine. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(signature);
}

/**
 * Constant-time string equality. Length mismatch returns false immediately —
 * length is not secret here (signatures are fixed-length hex).
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies a hex HMAC signature over `message`. Never throws — malformed
 * input only ever returns false (the engine's verifyHmacSignature contract,
 * mirrored).
 */
export async function verifyHmacHex(secret: string, message: string, providedHex: string): Promise<boolean> {
  try {
    const expected = await hmacSha256Hex(secret, message);
    return timingSafeEqualHex(expected, providedHex);
  } catch {
    return false;
  }
}

/** 16 random bytes, hex — nonces/challenges. Web Crypto, WinterCG-safe. */
export function randomHex16(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
