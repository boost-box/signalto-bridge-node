/**
 * pairing.ts — boot-time pairing confirmation (plan §5.4): an unconfirmed
 * connector POSTs the signed confirmation to the engine on boot. Idempotent
 * engine-side (a multi-instance boot storm is absorbed: the first instance
 * consumes the code, the rest re-confirm against the promoted key), so every
 * instance just fires the same attempt.
 *
 * Boot-safety contract (plan §5.7): startPairingLoop never throws, never
 * blocks the mount, and its retry timers are unref'd where the runtime
 * supports it — the connector must never keep a process alive or crash a
 * deploy over pairing. A definitive 400 (confirmation_rejected) stops the
 * loop — retrying a bad signature forever is noise; network/5xx/429 retry
 * with capped backoff.
 */
import { hmacSha256Hex } from './crypto.js';
import { connectionIdFromSiteKey } from './state.js';
import { CONNECTOR_VERSION } from './version.js';

/**
 * NO pairing code (DX review 2026-08-26): the engine minted the site key and
 * verifies this confirmation's HMAC against its own staged copy — key
 * possession is the proof, and the connection id rides inside the key. The
 * connector re-confirms on EVERY boot; the engine's idempotent path makes
 * that a no-op once active, and it self-heals a re-link (the new staged key
 * confirms on the next deploy).
 */
export interface PairingOptions {
  readonly engineUrl: string;
  readonly siteKey: string;
  readonly siteUrl: string;
  readonly controlBase: string;
  readonly fetchFn?: typeof fetch;
}

export type PairingAttemptResult =
  | { readonly outcome: 'confirmed'; readonly connectionId: number | null }
  | { readonly outcome: 'rejected' }
  | { readonly outcome: 'retryable'; readonly detail: string };

export async function attemptPairing(options: PairingOptions): Promise<PairingAttemptResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const connectionId = connectionIdFromSiteKey(options.siteKey);
  if (connectionId === null) return { outcome: 'rejected' }; // malformed key — retrying cannot help
  const timestamp = Date.now();
  const signature = await hmacSha256Hex(options.siteKey, `${connectionId}.${options.siteUrl}.${timestamp}`);
  let res: Response;
  try {
    res = await fetchFn(`${options.engineUrl.replace(/\/$/, '')}/bridge/node/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        connection_id: connectionId,
        site_url: options.siteUrl,
        timestamp,
        signature,
        control_base: options.controlBase,
        connector_version: CONNECTOR_VERSION,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { outcome: 'retryable', detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.ok) {
    let connectionId: number | null = null;
    try {
      const body = (await res.json()) as { connection_id?: unknown };
      connectionId = typeof body.connection_id === 'number' ? body.connection_id : null;
    } catch {
      connectionId = null;
    }
    return { outcome: 'confirmed', connectionId };
  }
  if (res.status === 400) return { outcome: 'rejected' };
  return { outcome: 'retryable', detail: `engine_status_${res.status}` };
}

const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
const MAX_ATTEMPTS = 10;

export interface PairingLoopHandle {
  /** Resolves when the loop finishes (confirmed, rejected, or attempts exhausted). Tests await this; production fire-and-forgets. */
  readonly done: Promise<'confirmed' | 'rejected' | 'exhausted'>;
}

export function startPairingLoop(
  options: PairingOptions,
  onStatus?: (status: string) => void,
): PairingLoopHandle {
  const done = (async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await attemptPairing(options);
      if (result.outcome === 'confirmed') {
        onStatus?.('confirmed');
        return 'confirmed' as const;
      }
      if (result.outcome === 'rejected') {
        onStatus?.('rejected');
        return 'rejected' as const;
      }
      onStatus?.(`retry:${result.detail}`);
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        // Never keep the customer's process alive for our retry (plan §5.7).
        (timer as { unref?: () => void }).unref?.();
      });
    }
    onStatus?.('exhausted');
    return 'exhausted' as const;
  })().catch(() => 'exhausted' as const); // unrepresentable, but the contract is never-throw
  return { done };
}
