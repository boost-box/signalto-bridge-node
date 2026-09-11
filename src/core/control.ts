/**
 * control.ts — the in-app control surface (/__signalto/*, plan §5.4): the
 * READ/REFRESH-ONLY endpoints the engine calls. No write endpoints — writes
 * only flow engine → state → pull.
 *
 * Flood posture (plan §5.7): this surface lives inside the customer's app,
 * so bogus traffic burns THEIR cpu. Cheap rejects run FIRST (method, path,
 * length, timestamp-window checks before any HMAC); a bounded global token
 * bucket caps sustained load; nonce replay is refused via a bounded cache,
 * which only a SIGNATURE-VERIFIED request may write to (unauthenticated
 * traffic must never be able to fill it and lock the engine out). A
 * flood degrades this surface only — never app traffic (the handler routes
 * only exact control-path requests here).
 *
 * Endpoints:
 *   GET  /ping?challenge=<hex>  — challenge-response key proof: only a
 *        connector holding the site key can sign the echo. Used by the
 *        engine's pairing back-probe and by nothing else. Unauthenticated by
 *        design (it IS the auth proof) — responds only when a well-formed
 *        challenge is present, and reveals only version + state version.
 *   GET  /capabilities          — signed: connector version + state version
 *        + wired slots (slice 2). The sweep's auth-liveness signal: a bad
 *        signature is answered 401, which the engine maps to
 *        AdapterAuthExpiredError.
 *   POST /refresh               — signed: re-pull state NOW (awaited, so the
 *        engine's post-apply verify sees fresh state), then 200.
 */
import { hmacSha256Hex, verifyHmacHex } from './crypto.js';
import type { StateClient } from './state.js';
import { CONNECTOR_VERSION } from './version.js';

/** A developer-declared slot (plan §5.5): what's wired, where it renders, and how its route reflects changes (the L-N13 gate's evidence). */
export interface SlotDeclaration {
  readonly opType: 'meta' | 'schema' | 'content';
  readonly name: string;
  /** The route the slot renders on — the revalidation target. */
  readonly path: string;
  /** 'dynamic' = per-request render; 'isr' = revalidatable; 'static' = build-time only (reflectable ONLY with a revalidation hook). */
  readonly mode: 'dynamic' | 'isr' | 'static';
}

/** Called after a refresh lands a doc whose slot values changed — the Next adapter wires revalidatePath here (spike S-5's hook). */
export type OnSlotsChanged = (changedPaths: readonly string[]) => void | Promise<void>;

const SIGNATURE_SKEW_MS = 10 * 60 * 1000;
const NONCE_CACHE_MAX = 1_000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const BUCKET_CAPACITY = 60;
const BUCKET_REFILL_MS = 1_000;

export interface ControlRequest {
  readonly method: string;
  /** Path RELATIVE to the control prefix, e.g. '/ping'. */
  readonly subPath: string;
  readonly query: URLSearchParams;
  /** Lowercased header lookup. */
  readonly header: (name: string) => string | undefined;
}

export interface ControlResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const json = (status: number, payload: unknown): ControlResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(payload),
});

export class ControlSurface {
  private readonly siteKey: string;
  private readonly state: StateClient;
  private readonly slots: readonly SlotDeclaration[];
  private onSlotsChanged: OnSlotsChanged | null;

  /** Bounded replay cache: nonce -> seenAt. */
  private readonly seenNonces = new Map<string, number>();
  private bucketTokens = BUCKET_CAPACITY;
  private bucketRefillAt = Date.now();

  private readonly autoHead: boolean;

  constructor(
    siteKey: string,
    state: StateClient,
    slots: readonly SlotDeclaration[] = [],
    onSlotsChanged: OnSlotsChanged | null = null,
    autoHead = false,
  ) {
    this.siteKey = siteKey;
    this.state = state;
    this.slots = slots;
    this.onSlotsChanged = onSlotsChanged;
    this.autoHead = autoHead;
  }

  /** Late wiring seam: the Next route-handler factory supplies revalidatePath after construction. */
  setOnSlotsChanged(callback: OnSlotsChanged): void {
    this.onSlotsChanged = callback;
  }

  private wiredSlotsReport(): { op_type: string; name: string; path: string; mode: string; revalidate: boolean }[] {
    // `revalidate` is per-report, not per-slot: one hook covers every wired
    // slot. Without the hook, static routes honestly report unreflectable —
    // the engine's capability gate excludes them (L-N13).
    const revalidate = this.onSlotsChanged !== null;
    return this.slots.map((slot) => ({ op_type: slot.opType, name: slot.name, path: slot.path, mode: slot.mode, revalidate }));
  }

  private takeToken(now: number): boolean {
    const refill = Math.floor((now - this.bucketRefillAt) / BUCKET_REFILL_MS);
    if (refill > 0) {
      this.bucketTokens = Math.min(BUCKET_CAPACITY, this.bucketTokens + refill);
      this.bucketRefillAt = now;
    }
    if (this.bucketTokens <= 0) return false;
    this.bucketTokens -= 1;
    return true;
  }

  private nonceReplayed(nonce: string, now: number): boolean {
    // Prune expired entries when the cache is full — bounded, never growing.
    if (this.seenNonces.size >= NONCE_CACHE_MAX) {
      for (const [seen, at] of this.seenNonces) {
        if (now - at > NONCE_TTL_MS) this.seenNonces.delete(seen);
      }
      if (this.seenNonces.size >= NONCE_CACHE_MAX) return true; // full of live nonces — refuse rather than evict live protection
    }
    if (this.seenNonces.has(nonce)) return true;
    this.seenNonces.set(nonce, now);
    return false;
  }

  /** Verifies the x-signalto-* signature headers for `action`. Cheap checks first; returns null on success or a refusal response. */
  private async verifySigned(request: ControlRequest, action: string, now: number): Promise<ControlResponse | null> {
    const timestamp = Number(request.header('x-signalto-timestamp'));
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > SIGNATURE_SKEW_MS) {
      return json(401, { error: { code: 'timestamp_out_of_window' } });
    }
    const nonce = request.header('x-signalto-nonce');
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 64) {
      return json(401, { error: { code: 'missing_nonce' } });
    }
    const signature = request.header('x-signalto-signature');
    if (typeof signature !== 'string' || signature.length !== 64) {
      return json(401, { error: { code: 'signature_invalid' } });
    }
    // Verify BEFORE recording the nonce. Recording first let unauthenticated
    // traffic write to the replay cache: a flood of bogus signatures carrying
    // guessed nonces filled it with live entries, and once full it refuses
    // rather than evicting — so an attacker who never holds the site key
    // could lock the engine out of its own control surface. Only a request
    // that PROVES key possession may consume a nonce.
    if (!(await verifyHmacHex(this.siteKey, `${action}.${timestamp}.${nonce}`, signature))) {
      return json(401, { error: { code: 'signature_invalid' } });
    }
    // Replay semantics for VALID signatures are unchanged: the first use of a
    // nonce is recorded and accepted, any re-use of it is refused.
    if (this.nonceReplayed(nonce, now)) {
      return json(401, { error: { code: 'nonce_replayed' } });
    }
    return null;
  }

  async handle(request: ControlRequest, now: number = Date.now()): Promise<ControlResponse> {
    if (!this.takeToken(now)) {
      return json(429, { error: { code: 'too_many_requests' } });
    }

    if (request.subPath === '/ping' && request.method === 'GET') {
      const challenge = request.query.get('challenge');
      if (!challenge || !/^[0-9a-f]{1,64}$/.test(challenge)) {
        return json(400, { error: { code: 'missing_challenge' } });
      }
      const signature = await hmacSha256Hex(this.siteKey, `ping.${challenge}`);
      return json(200, {
        ok: true,
        version: CONNECTOR_VERSION,
        state_version: this.state.getSnapshot().version,
        signature,
      });
    }

    if (request.subPath === '/capabilities' && request.method === 'GET') {
      const refused = await this.verifySigned(request, 'capabilities', now);
      if (refused) return refused;
      return json(200, {
        ok: true,
        version: CONNECTOR_VERSION,
        state_version: this.state.getSnapshot().version,
        wired_slots: this.wiredSlotsReport(),
        auto_head: this.autoHead,
        health: this.state.health(),
      });
    }

    if (request.subPath === '/read' && request.method === 'GET') {
      const refused = await this.verifySigned(request, 'read', now);
      if (refused) return refused;
      // Auto-head read-back (slice A1): the head entry the connector is
      // currently serving from — the engine's verifyApplied target for
      // head ops (same D-12 read-back pattern as slots).
      const headPath = request.query.get('head');
      if (headPath !== null) {
        if (!headPath.startsWith('/') || headPath.includes('?')) {
          return json(400, { error: { code: 'invalid_head_path' } });
        }
        return json(200, {
          ok: true,
          head: headPath,
          value: this.state.getSnapshot().heads.get(headPath) ?? null,
          auto_head: this.autoHead,
          state_version: this.state.getSnapshot().version,
        });
      }
      const slot = request.query.get('slot');
      if (!slot || !/^(meta|schema|content)\/[A-Za-z0-9._-]{1,128}$/.test(slot)) {
        return json(400, { error: { code: 'invalid_slot_key' } });
      }
      // The value the app CURRENTLY renders from (the pulled snapshot) —
      // the engine's verifyApplied read-back target (D-12). null = unmanaged
      // (the wired fallback renders); never fabricated.
      return json(200, {
        ok: true,
        slot,
        value: this.state.getSnapshot().slots.get(slot) ?? null,
        state_version: this.state.getSnapshot().version,
      });
    }

    if (request.subPath === '/refresh' && request.method === 'POST') {
      const refused = await this.verifySigned(request, 'refresh', now);
      if (refused) return refused;
      const before = this.state.getSnapshot();
      await this.state.refreshNow();
      const after = this.state.getSnapshot();
      // S-5's hook: slot values that changed in this refresh trigger the
      // revalidation callback (Next: revalidatePath) for their routes —
      // awaited, so the engine's post-apply verify sees the reflected state.
      // Callback failures are reported, never thrown (the refresh itself
      // succeeded; the TTL/next-request still serves the new state).
      let revalidated: string[] | null = null;
      let revalidateError: string | null = null;
      if (this.onSlotsChanged && after.version !== before.version) {
        const changedPaths = new Set<string>();
        for (const slot of this.slots) {
          const key = `${slot.opType}/${slot.name}`;
          const beforeValue = JSON.stringify(before.slots.get(key) ?? null);
          const afterValue = JSON.stringify(after.slots.get(key) ?? null);
          if (beforeValue !== afterValue) changedPaths.add(slot.path);
        }
        if (changedPaths.size > 0) {
          revalidated = [...changedPaths];
          try {
            await this.onSlotsChanged(revalidated);
          } catch (err) {
            revalidateError = err instanceof Error ? err.message : String(err);
          }
        }
      }
      return json(200, {
        ok: true,
        state_version: after.version,
        ...(revalidated ? { revalidated } : {}),
        ...(revalidateError ? { revalidate_error: revalidateError } : {}),
      });
    }

    return json(404, { error: { code: 'not_found' } });
  }
}
