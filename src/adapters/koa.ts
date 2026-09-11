/**
 * adapters/koa.ts — the Koa mount (plan §8):
 *
 *   import { signaltoKoa } from '@signalto/bridge-node/koa';
 *   app.use(signaltoKoa());   // FIRST middleware
 *
 * Koa buffers the response and commits headers at the end of the middleware
 * chain, so header set/remove happens AFTER `await next()` — no patching.
 * Structurally typed (no koa import — zero runtime deps).
 *
 * Do-no-harm phases are strictly separated: OUR decision/serve/mutation
 * errors degrade to pass-through + health flag; an error thrown by the APP
 * inside `next()` propagates untouched to Koa's own handling — the bridge
 * never swallows it and never re-runs the app.
 *
 * AUTO-HEAD uses the same seam: after `await next()` the app's HTML is sitting
 * in `ctx.body`, so the shared buffered-head transform replaces it in place —
 * same C-4 gate, same rewriter, same combined ETag as the node and fetch
 * handlers. Koa recomputes content-length from the body it is handed, so the
 * rewritten page is always correctly framed. A body we cannot read (a stream)
 * is a health-flagged pass-through, never a corrupted response.
 */
import { createBridge, SignalToBridge, type BridgeOptions, type Decision } from '../index.js';
import type { ControlRequest } from '../core/control.js';
import { transformBufferedHead } from '../handlers/bufferedHead.js';
import type { ManagedHead } from '../core/headRewriter.js';

/** The narrow structural slice of Koa's ctx this middleware touches. */
interface Koaish {
  method: string;
  path: string;
  querystring: string;
  status: number;
  body: unknown;
  set(name: string, value: string): void;
  remove(name: string): void;
  /** REQUEST header lookup (Koa's ctx.get). */
  get(name: string): string;
  /** The raw node request — auto-head strips the conditional/encoding headers from it (C-1/C-10). */
  req?: { headers: Record<string, string | string[] | undefined> };
  /** RESPONSE header lookup, for the auto-head gate. */
  response?: { get(name: string): string };
}

/**
 * Runs the buffered auto-head transform over `ctx.body`. Every outcome except
 * a transform leaves the app's response exactly as it built it.
 */
function applyHeadTransform(
  bridge: SignalToBridge,
  ctx: Koaish,
  managed: ManagedHead,
  stateVersion: number,
  ifNoneMatch: string | null,
): void {
  const readHeader = (name: string): string | null => {
    const value = ctx.response?.get(name);
    return value ? value : null;
  };
  const result = transformBufferedHead(
    { method: ctx.method ?? 'GET', ifNoneMatch },
    {
      status: ctx.status,
      contentType: readHeader('content-type'),
      contentEncoding: readHeader('content-encoding'),
      etag: readHeader('etag'),
      payload: ctx.body,
    },
    managed,
    stateVersion,
  );

  if (result.kind === 'passthrough') {
    if (result.refusal) bridge.recordInternalError(`autohead_refused:${result.refusal}`);
    else if (result.unsupportedPayload) bridge.recordInternalError('autohead_unsupported_payload');
    return;
  }
  if (result.kind === 'not-modified') {
    // Koa's status setter drops the body (and then the content headers) for
    // an empty status, so this is the whole 304.
    ctx.status = 304;
    ctx.set('etag', result.etag);
    return;
  }
  ctx.remove('last-modified');
  if (result.etag) ctx.set('etag', result.etag);
  else ctx.remove('etag');
  // Assigning a string body re-derives content-length from it.
  ctx.body = result.body;
}

export interface KoaBridgeMiddleware {
  (ctx: Koaish, next: () => Promise<unknown>): Promise<void>;
  readonly bridge: SignalToBridge;
}

export function signaltoKoa(options: BridgeOptions = {}): KoaBridgeMiddleware {
  const bridge = createBridge(options);

  const middleware = async function signaltoBridgeKoa(ctx: Koaish, next: () => Promise<unknown>): Promise<void> {
    // Phase 1 — OUR decision. Any failure here degrades to pass-through.
    let decision: Decision = { kind: 'pass' };
    let echo: Record<string, string> = {};
    let isControl = false;
    try {
      const path = ctx.path ?? '/';
      isControl = bridge.isControlPath(path);
      if (!isControl) {
        decision = bridge.decide(ctx.method ?? 'GET', path);
        const search = ctx.querystring ?? '';
        const probeNonce = search !== '' && search.includes('__signalto_probe')
          ? new URLSearchParams(search).get('__signalto_probe')
          : null;
        if (probeNonce) echo = await bridge.probeEchoHeader(probeNonce);
      }
    } catch {
      bridge.recordInternalError('koa_decide');
      decision = { kind: 'pass' };
      echo = {};
    }

    // Phase 2a — control surface (ours entirely; failure = 500 on OUR path only).
    if (isControl) {
      try {
        const controlRequest: ControlRequest = {
          method: ctx.method ?? 'GET',
          subPath: (ctx.path ?? '/').slice(bridge.controlPath.length) || '/',
          query: new URLSearchParams(ctx.querystring ?? ''),
          header: (name) => ctx.get(name) || undefined,
        };
        const response = await bridge.handleControl(controlRequest);
        ctx.status = response.status;
        for (const [name, value] of Object.entries(response.headers)) ctx.set(name, value);
        ctx.body = response.body;
      } catch {
        bridge.recordInternalError('koa_control');
        ctx.status = 500;
        ctx.body = '{"error":{"code":"internal"}}';
      }
      return;
    }

    // Phase 2b — managed serve (ours; failure degrades to pass-through below).
    if (decision.kind === 'respond') {
      try {
        ctx.status = decision.status;
        for (const [name, value] of Object.entries({ ...decision.headers, ...echo })) ctx.set(name, value);
        ctx.body = (ctx.method ?? 'GET') === 'HEAD' ? '' : decision.body;
        return;
      } catch {
        bridge.recordInternalError('koa_respond');
        // fall through to the app
      }
    }

    // Phase 2c — auto-head: capture the client's validator and take the app
    // out of the revalidation/compression business before it renders.
    let ifNoneMatch: string | null = null;
    if (decision.kind === 'transform-head') {
      try {
        ifNoneMatch = ctx.get('if-none-match') || null;
        if (ctx.req) {
          delete ctx.req.headers['if-none-match'];   // C-1: we own revalidation
          delete ctx.req.headers['if-modified-since'];
          delete ctx.req.headers['accept-encoding']; // C-10: disengage in-process compression
        }
      } catch {
        bridge.recordInternalError('koa_autohead_request');
      }
    }

    // Phase 3 — the APP. Its errors propagate untouched (never ours to hide).
    await next();

    // Phase 4a — auto-head on the buffered body (ours; failure leaves the app's response alone).
    if (decision.kind === 'transform-head') {
      try {
        applyHeadTransform(bridge, ctx, decision.managed as ManagedHead, decision.stateVersion, ifNoneMatch);
      } catch {
        bridge.recordInternalError('koa_autohead');
      }
    }

    // Phase 4b — OUR header mutations on the buffered response.
    try {
      if (decision.kind === 'mutate-headers') {
        for (const [name, value] of Object.entries(decision.set)) ctx.set(name, value);
        for (const name of decision.remove) ctx.remove(name);
      }
      for (const [name, value] of Object.entries(echo)) ctx.set(name, value);
    } catch {
      bridge.recordInternalError('koa_mutate');
    }
  } as KoaBridgeMiddleware;

  Object.defineProperty(middleware, 'bridge', { value: bridge, enumerable: false });
  return middleware;
}

export { createBridge, SignalToBridge };
export type { BridgeOptions };
