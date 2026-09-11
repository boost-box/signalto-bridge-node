/**
 * state.ts — the connector's SWR state client (plan §5.2/§5.7).
 *
 * The engine owns the desired state; this client pulls it and holds ONE
 * compiled snapshot in memory. The binding hot-path contract (§5.7):
 *
 *   - getSnapshot() is SYNCHRONOUS and allocation-light — the request path
 *     never awaits anything here.
 *   - maybeRefresh() only ever FIRES a background pull (single-flight,
 *     .catch()ed) — an unhandled rejection from this module is
 *     unrepresentable.
 *   - Engine unreachable => serve last-good; no cache at all => the compiled
 *     snapshot is EMPTY and every request passes through untouched. The
 *     engine's latency/availability can never appear in a customer request.
 *   - An invalid/unknown-schema doc is rejected WHOLE and last-good kept.
 *   - Repeated definitive 401s (revoked/re-linked connection) clear to
 *     pass-through — the site cleanly returns to unmanaged.
 *
 * FAILURE CADENCE: every settled pull — success OR failure — stamps
 * `lastFreshAt`, so a pull is attempted at most once per interval no matter
 * how many requests arrive. Without that stamp an engine outage would re-pull
 * at REQUEST rate (the staleness compare never advances), turning our outage
 * into their thundering herd. Consecutive failures then back off
 * exponentially — 1×, 2×, 4× TTL — to a ceiling of MAX_BACKOFF_MULTIPLIER×
 * TTL, and the first success resets the ladder to the plain TTL cadence.
 */
import { hmacSha256Hex, randomHex16 } from './crypto.js';
import { validateStateDoc, type NodeBridgeStateDoc, type RedirectRule } from './validate.js';

export interface CompiledState {
  readonly version: number;
  readonly robots: string | null;
  readonly rootFiles: ReadonlyMap<string, string>;
  readonly redirects: ReadonlyMap<string, RedirectRule>;
  readonly headerRules: ReadonlyMap<string, Readonly<Record<string, string | null>>>;
  /** Managed slot values keyed `<opType>/<name>` (slice 2). */
  readonly slots: ReadonlyMap<string, unknown>;
  /** Auto-head entries keyed by query-stripped path (auto-head slice A1). */
  readonly heads: ReadonlyMap<string, Record<string, unknown>>;
}

export const EMPTY_STATE: CompiledState = {
  version: 0,
  robots: null,
  rootFiles: new Map(),
  redirects: new Map(),
  headerRules: new Map(),
  slots: new Map(),
  heads: new Map(),
};

/** Matchers compile ONCE per adopted doc version — never per request (§5.7). */
export function compileState(version: number, doc: NodeBridgeStateDoc): CompiledState {
  const rootFiles = new Map<string, string>();
  for (const [path, content] of Object.entries(doc.rootFiles ?? {})) {
    rootFiles.set(`/${path}`, content);
  }
  const redirects = new Map<string, RedirectRule>();
  for (const rule of doc.redirects ?? []) {
    redirects.set(rule.from, rule);
  }
  const headerRules = new Map<string, Record<string, string | null>>();
  for (const [path, rule] of Object.entries(doc.headerRules ?? {})) {
    headerRules.set(path, rule);
  }
  const slots = new Map<string, unknown>();
  for (const [key, value] of Object.entries(doc.slots ?? {})) {
    slots.set(key, value);
  }
  const heads = new Map<string, Record<string, unknown>>();
  for (const [path, entry] of Object.entries(doc.heads ?? {})) {
    heads.set(path, entry);
  }
  return {
    version,
    robots: doc.robots ?? null,
    rootFiles,
    redirects,
    headerRules,
    slots,
    heads,
  };
}

export interface StateClientOptions {
  readonly engineUrl: string;
  readonly siteKey: string;
  /** Pull TTL — how stale a snapshot may get before a background refresh fires. */
  readonly ttlMs?: number;
  readonly fetchFn?: typeof fetch;
}

export interface StateClientHealth {
  readonly lastPullOkAt: number | null;
  readonly lastPullError: string | null;
  readonly consecutiveUnauthorized: number;
  /** Consecutive failed pulls — 0 while healthy. Drives the backoff ladder and tells the sweep how long we've been blind. */
  readonly consecutiveFailures: number;
}

const DEFAULT_TTL_MS = 60_000;
/** Backoff ceiling: a sustained outage retries no slower than once per 5× TTL. */
const MAX_BACKOFF_MULTIPLIER = 5;
/** After this many consecutive definitive 401s the doc clears to pass-through — a revoked connection cleanly unmanages the site (plan §5.6). */
const UNAUTHORIZED_CLEAR_THRESHOLD = 3;

/** Parses the connection id embedded in the site key (sk_<id>_<secret>) — the state GET must name its connection. Returns null on any malformed key. */
export function connectionIdFromSiteKey(siteKey: string): number | null {
  const match = /^sk_(\d+)_[0-9a-f]+$/.exec(siteKey);
  if (!match) return null;
  const id = Number.parseInt(match[1]!, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export class StateClient {
  private readonly engineUrl: string;
  private readonly siteKey: string;
  private readonly connectionId: number | null;
  private readonly ttlMs: number;
  private readonly fetchFn: typeof fetch;

  private snapshot: CompiledState = EMPTY_STATE;
  private lastFreshAt = 0;
  private inflight: Promise<void> | null = null;
  private lastPullOkAt: number | null = null;
  private lastPullError: string | null = null;
  private consecutiveUnauthorized = 0;
  private consecutiveFailures = 0;

  constructor(options: StateClientOptions) {
    this.engineUrl = options.engineUrl.replace(/\/$/, '');
    this.siteKey = options.siteKey;
    this.connectionId = connectionIdFromSiteKey(options.siteKey);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** SYNC — the hot path's only read. */
  getSnapshot(): CompiledState {
    return this.snapshot;
  }

  /**
   * Resolves once the FIRST pull attempt has settled (success OR failure —
   * never rejects). Slot helpers race this with a short timeout so a
   * cold-start render waits briefly for real values but an engine outage
   * still renders fallbacks (L-N9 — never a hung render).
   */
  firstPullSettled(): Promise<void> {
    if (this.lastPullOkAt !== null || this.lastPullError !== null) return Promise.resolve();
    this.maybeRefresh();
    return this.inflight ?? Promise.resolve();
  }

  health(): StateClientHealth {
    return {
      lastPullOkAt: this.lastPullOkAt,
      lastPullError: this.lastPullError,
      consecutiveUnauthorized: this.consecutiveUnauthorized,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /** How long the current failure streak makes us wait: TTL while healthy, doubling per failure to the ceiling. */
  private pullIntervalMs(): number {
    if (this.consecutiveFailures === 0) return this.ttlMs;
    const multiplier = Math.min(2 ** (this.consecutiveFailures - 1), MAX_BACKOFF_MULTIPLIER);
    return this.ttlMs * multiplier;
  }

  /** Every settled pull stamps freshness; a failure also advances the backoff ladder. */
  private noteSettled(failed: boolean): void {
    this.lastFreshAt = Date.now();
    this.consecutiveFailures = failed ? this.consecutiveFailures + 1 : 0;
  }

  /**
   * Lazily triggers a background refresh when the snapshot is stale.
   * SYNC, non-blocking, single-flight — the caller never waits.
   */
  maybeRefresh(now: number = Date.now()): void {
    if (this.inflight) return;
    if (now - this.lastFreshAt < this.pullIntervalMs()) return;
    this.inflight = this.pull()
      .catch(() => { /* recorded in health inside pull(); never thrown to the app */ })
      .finally(() => { this.inflight = null; });
  }

  /** Forced refresh (the /refresh control call awaits this so the engine's post-apply verify sees fresh state). Joins any in-flight pull. */
  refreshNow(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.pull()
        .catch(() => { /* recorded in health */ })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async pull(): Promise<void> {
    if (this.connectionId === null) {
      this.lastPullError = 'malformed_site_key';
      this.noteSettled(true);
      return;
    }
    const timestamp = Date.now();
    const nonce = randomHex16();
    const signature = await hmacSha256Hex(this.siteKey, `state.${this.connectionId}.${timestamp}.${nonce}`);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.engineUrl}/bridge/node/state`, {
        method: 'GET',
        headers: {
          'x-signalto-connection-id': String(this.connectionId),
          'x-signalto-timestamp': String(timestamp),
          'x-signalto-nonce': nonce,
          'x-signalto-signature': signature,
          ...(this.snapshot.version > 0 ? { 'if-none-match': `"v${this.snapshot.version}"` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Engine unreachable: keep serving last-good (plan L-N9) and back off —
      // an outage must cost ONE pull per interval, not one per request.
      this.lastPullError = err instanceof Error ? err.message : String(err);
      this.noteSettled(true);
      return;
    }

    if (res.status === 304) {
      this.noteSettled(false);
      this.lastPullOkAt = this.lastFreshAt;
      this.lastPullError = null;
      this.consecutiveUnauthorized = 0;
      return;
    }
    if (res.status === 401) {
      this.consecutiveUnauthorized += 1;
      this.lastPullError = 'unauthorized';
      if (this.consecutiveUnauthorized >= UNAUTHORIZED_CLEAR_THRESHOLD) {
        // Revoked/re-linked: cleanly return the site to unmanaged.
        this.snapshot = EMPTY_STATE;
      }
      // Every 401 backs off — the 1st and 2nd are still failures, and before
      // this the pre-threshold ones re-pulled at request rate.
      this.noteSettled(true);
      return;
    }
    if (res.status === 429) {
      // Our own budget — back off without touching the snapshot.
      this.lastPullError = 'rate_limited';
      this.noteSettled(true);
      return;
    }
    if (!res.ok) {
      this.lastPullError = `engine_status_${res.status}`;
      this.noteSettled(true);
      return;
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      this.lastPullError = err instanceof Error ? err.message : String(err);
      this.noteSettled(true);
      return;
    }
    let envelope: { version?: unknown; schema_version?: unknown; state?: unknown };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch {
      this.lastPullError = 'invalid_envelope_json';
      this.noteSettled(true);
      return;
    }
    const version = typeof envelope.version === 'number' ? envelope.version : null;
    const schemaVersion = typeof envelope.schema_version === 'number' ? envelope.schema_version : null;
    if (version === null || schemaVersion === null || typeof envelope.state !== 'object' || envelope.state === null) {
      this.lastPullError = 'invalid_envelope_shape';
      this.noteSettled(true);
      return;
    }
    const validated = validateStateDoc(JSON.stringify(envelope.state), schemaVersion);
    if (!validated.ok) {
      // Reject WHOLE, keep last-good (plan §5.2) — but count freshness so a
      // permanently-bad doc doesn't hot-loop the pull.
      this.lastPullError = `doc_rejected:${validated.reason}`;
      this.noteSettled(true);
      return;
    }

    this.snapshot = compileState(version, validated.doc);
    this.noteSettled(false);
    this.lastPullOkAt = this.lastFreshAt;
    this.lastPullError = null;
    this.consecutiveUnauthorized = 0;
  }
}
