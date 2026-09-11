/**
 * @signalto/bridge-node — the SignalTo content-bridge connector core.
 *
 * Runtime-agnostic (WinterCG-safe: Web Crypto + fetch only). Framework
 * handlers wrap this core:
 *   - `@signalto/bridge-node/express` — Express/Connect middleware
 *   - `@signalto/bridge-node/node`    — plain (req, res, next) handler
 *
 * THE BINDING CONTRACT (plan §5.7 — performance & do-no-harm):
 *   - decide() is SYNCHRONOUS and allocation-light: an unmanaged request
 *     costs a few Map lookups + one staleness compare. Zero awaits, zero
 *     network on the request path — ever.
 *   - A missing/invalid configuration yields an INERT bridge (pure
 *     pass-through + health flag), never a boot crash.
 *   - The connector never throws into the app: handlers wrap every path;
 *     any internal error → pass through untouched + health flag.
 */
import { ControlSurface, type ControlRequest, type ControlResponse, type OnSlotsChanged, type SlotDeclaration } from './core/control.js';
import { hmacSha256Hex } from './core/crypto.js';
import { startPairingLoop, type PairingLoopHandle } from './core/pairing.js';
import { StateClient, type CompiledState } from './core/state.js';
import { CONNECTOR_VERSION } from './core/version.js';

export { CONNECTOR_VERSION };
export type { ControlRequest, ControlResponse, OnSlotsChanged, SlotDeclaration };

/**
 * The production engine address, baked in so a customer sets TWO env vars
 * (an SDK doesn't ask for api.stripe.com). SIGNALTO_ENGINE_URL / the
 * engineUrl option override it for staging/dev engines. Kept in lockstep
 * with the engine's DEFAULT_NODE_CONNECTOR_ENGINE_URL (linkSite.ts) — the
 * engine's link instructions mention the override only when it is not at
 * this address.
 */
export const DEFAULT_ENGINE_URL = 'https://api.signalto.ai';

export interface BridgeOptions {
  /** Engine base URL override — defaults to SIGNALTO_ENGINE_URL, then the baked production DEFAULT_ENGINE_URL. */
  readonly engineUrl?: string;
  /** The engine-minted site key (sk_<id>_<secret>) — defaults to SIGNALTO_SITE_KEY. Shown once by link_site. */
  readonly siteKey?: string;
  /** The site's public origin (https://example.com) — defaults to SIGNALTO_SITE_URL. Needed only for pairing. */
  readonly siteUrl?: string;
  /** Control-surface mount path. Default '/__signalto'. */
  readonly controlPath?: string;
  /** State pull TTL (ms). Default 60s. */
  readonly cacheTtlMs?: number;
  readonly fetchFn?: typeof fetch;
  /**
   * The wired slots (plan §5.5): declare each signaltoMeta/Schema/Content
   * integration point here — its id, the route it renders on, and how that
   * route reflects changes. What's declared (and reflectable) is exactly
   * what SignalTo offers to edit; nothing else.
   */
  readonly slots?: readonly SlotDeclaration[];
  /** Called with the routes whose slot values changed on a refresh — wire your framework's revalidation here (Next: revalidatePath). */
  readonly onSlotsChanged?: OnSlotsChanged;
  /**
   * Auto-head (opt-in, D-A6): on pages the
   * engine holds a managed head for, the handler transforms the LIVE
   * response's <head> (title/description/canonical/JSON-LD) as it streams
   * through. React-hydrated pages are detected and refused (C-14); the app
   * remains the source of truth for everything else on the page.
   */
  readonly autoHead?: boolean;
}

/** What the handler should do with one request — computed synchronously. */
export type Decision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'respond'; readonly status: number; readonly headers: Record<string, string>; readonly body: string }
  | { readonly kind: 'mutate-headers'; readonly set: Record<string, string>; readonly remove: readonly string[] }
  | { readonly kind: 'transform-head'; readonly managed: Record<string, unknown>; readonly stateVersion: number }
  | { readonly kind: 'control' };

/** FNV-1a hex — a cheap, sync, runtime-agnostic content identity for the C-1 combined ETag (cache keying, not security). */
export function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The C-1 combined validator: changes when the HEAD STATE changes AND tracks
 * the app's own validator (a version-only ETag would 304 stale BODIES after
 * an app deploy). No app ETag -> null: we then never 304 — always correct,
 * never stale.
 */
export function combinedHeadEtag(stateVersion: number, appEtag: string | null): string | null {
  if (!appEtag) return null;
  return `W/"sth-${stateVersion}-${fnv1aHex(appEtag)}"`;
}

const env = (name: string): string | undefined =>
  typeof process !== 'undefined' ? process.env?.[name] : undefined;

function contentTypeFor(path: string): string {
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

export class SignalToBridge {
  readonly controlPath: string;
  readonly configured: boolean;
  readonly autoHead: boolean;
  readonly state: StateClient | null;
  private readonly control: ControlSurface | null;
  private readonly siteKey: string | null;
  private pairing: PairingLoopHandle | null = null;
  private healthFlag: string | null = null;

  constructor(options: BridgeOptions = {}) {
    this.controlPath = (options.controlPath ?? '/__signalto').replace(/\/$/, '');
    this.autoHead = options.autoHead === true;
    const siteKey = options.siteKey ?? env('SIGNALTO_SITE_KEY') ?? null;
    const engineUrl = options.engineUrl ?? env('SIGNALTO_ENGINE_URL') ?? DEFAULT_ENGINE_URL;
    this.siteKey = siteKey;

    if (!siteKey) {
      // Inert, never a crash (plan §5.7): the app runs exactly as if the
      // bridge were absent; health names why.
      this.configured = false;
      this.state = null;
      this.control = null;
      this.healthFlag = 'missing_site_key';
      return;
    }

    this.configured = true;
    this.state = new StateClient({
      engineUrl,
      siteKey,
      ...(options.cacheTtlMs !== undefined ? { ttlMs: options.cacheTtlMs } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    });
    this.control = new ControlSurface(siteKey, this.state, options.slots ?? [], options.onSlotsChanged ?? null, this.autoHead);

    // Re-confirm on EVERY boot (no pairing code — DX review 2026-08-26):
    // key possession is the proof, the engine's idempotent path makes an
    // already-active confirm a no-op, and a re-link's new staged key
    // self-heals on the next deploy.
    const siteUrl = (options.siteUrl ?? env('SIGNALTO_SITE_URL'))?.replace(/\/$/, '');
    if (siteUrl) {
      this.pairing = startPairingLoop({
        engineUrl,
        siteKey,
        siteUrl,
        controlBase: `${siteUrl}${this.controlPath}`,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      }, (status) => { this.healthFlag = `pairing:${status}`; });
    }

    // First pull warms the cache off the request path (fire-and-forget,
    // single-flight — a cold-start request that beats it passes through).
    this.state.maybeRefresh();
  }

  /** Tests (and curious operators) can await pairing completion; production never does. */
  pairingDone(): Promise<string> | null {
    return this.pairing ? this.pairing.done : null;
  }

  /** Late revalidation wiring (the Next route-handler factory supplies revalidatePath after construction). */
  setOnSlotsChanged(callback: OnSlotsChanged): void {
    this.control?.setOnSlotsChanged(callback);
  }

  /**
   * SYNC slot read: the managed value, or `fallback` when unmanaged/unpulled.
   * The hot-render path — a couple of Map lookups, never a wait.
   */
  slot<T>(opType: 'meta' | 'schema' | 'content', name: string, fallback: T): T {
    if (!this.state) return fallback;
    this.state.maybeRefresh();
    const value = this.state.getSnapshot().slots.get(`${opType}/${name}`);
    return value === undefined || value === null ? fallback : (value as T);
  }

  /**
   * Cold-start-tolerant slot read for async render contexts (Next
   * generateMetadata): waits for the FIRST pull to settle, but never longer
   * than `timeoutMs` — an engine outage renders the fallback, never a hung
   * page (L-N9).
   */
  async slotAsync<T>(opType: 'meta' | 'schema' | 'content', name: string, fallback: T, timeoutMs = 1_500): Promise<T> {
    if (!this.state) return fallback;
    await Promise.race([
      this.state.firstPullSettled(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    return this.slot(opType, name, fallback);
  }

  health(): { configured: boolean; flag: string | null } {
    return { configured: this.configured, flag: this.healthFlag };
  }

  recordInternalError(context: string): void {
    // Degradation is visible to us (the sweep reads health via
    // /capabilities), invisible to the customer's visitors (plan §5.7).
    this.healthFlag = `internal_error:${context}`;
  }

  isControlPath(path: string): boolean {
    return this.configured && (path === this.controlPath || path.startsWith(`${this.controlPath}/`));
  }

  /**
   * SYNC hot path. `probeNonce` is the __signalto_probe query value when
   * present (the handler extracts it only after a cheap substring check).
   * When a probe is present the handler must overlay the async echo header
   * via probeEchoHeader() — the only async step, and only on probe requests.
   */
  decide(method: string, path: string, now: number = Date.now()): Decision {
    if (!this.configured || !this.state) return { kind: 'pass' };
    if (this.isControlPath(path)) return { kind: 'control' };

    this.state.maybeRefresh(now);
    const snapshot: CompiledState = this.state.getSnapshot();

    const isRead = method === 'GET' || method === 'HEAD';

    // Redirects run first — before app routing, before managed files on
    // other paths can shadow them.
    const redirect = snapshot.redirects.get(path);
    if (redirect && isRead) {
      return {
        kind: 'respond',
        status: redirect.statusCode ?? 301,
        headers: { location: redirect.to, 'cache-control': 'no-store' },
        body: '',
      };
    }

    if (isRead && path === '/robots.txt' && snapshot.robots !== null) {
      return {
        kind: 'respond',
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: snapshot.robots,
      };
    }

    if (isRead) {
      const rootFile = snapshot.rootFiles.get(path);
      if (rootFile !== undefined) {
        return {
          kind: 'respond',
          status: 200,
          headers: { 'content-type': contentTypeFor(path) },
          body: rootFile,
        };
      }
    }

    // Auto-head sits AFTER managed serves/redirects (a redirect on the path
    // still wins) and TAKES the slot over header rules on the same path —
    // documented precedence, one writer per response.
    if (this.autoHead && isRead) {
      const managedHead = snapshot.heads.get(path);
      if (managedHead) {
        return { kind: 'transform-head', managed: managedHead, stateVersion: snapshot.version };
      }
    }

    const headerRule = snapshot.headerRules.get(path);
    if (headerRule) {
      const set: Record<string, string> = {};
      const remove: string[] = [];
      for (const [name, value] of Object.entries(headerRule)) {
        if (value === null) remove.push(name);
        else set[name] = value;
      }
      return { kind: 'mutate-headers', set, remove };
    }

    return { kind: 'pass' };
  }

  /** The end-to-end probe echo (plan L-N6/L-N14): only computed on probe requests, never on the normal hot path. */
  async probeEchoHeader(probeNonce: string): Promise<Record<string, string>> {
    if (!this.siteKey || !/^[0-9a-f]{1,64}$/.test(probeNonce)) return {};
    try {
      return { 'x-signalto-probe': await hmacSha256Hex(this.siteKey, `probe.${probeNonce}`) };
    } catch {
      return {};
    }
  }

  async handleControl(request: ControlRequest): Promise<ControlResponse> {
    if (!this.control) {
      return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'not_found' } }) };
    }
    return this.control.handle(request);
  }
}

export function createBridge(options: BridgeOptions = {}): SignalToBridge {
  return new SignalToBridge(options);
}
