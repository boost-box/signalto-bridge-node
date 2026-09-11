/**
 * handlers/fetch.ts — the canonical WinterCG handler (plan §8, slice 3): one
 * `(Request) => Response | undefined` shape covers the fetch-runtime family
 * — Hono, Remix, SvelteKit, Astro SSR, Nuxt/h3 — via thin mount recipes (see
 * the README). Zero deps, Web APIs only; the same core the node handler uses.
 *
 * Contract:
 *   - `next` PROVIDED  -> always returns a Response: ours (managed serve /
 *     redirect / control), or next()'s — with managed header set/remove and
 *     the probe echo applied to a CLONE (fetch-runtime Response headers are
 *     often immutable).
 *   - `next` OMITTED   -> returns a Response only when the bridge fully owns
 *     the request (managed serve / redirect / control); `undefined` means
 *     "continue" — but header rules and the '/' probe echo then cannot apply,
 *     so the end-to-end capability probes honestly report headers/redirects
 *     unavailable on unmatched paths. Pass `next` whenever the framework can
 *     hand you the downstream response.
 *
 * Unlike Next (two runtimes), fetch-family frameworks are single-runtime:
 * the control surface IS handled here, revalidation hooks and all.
 *
 * Do-no-harm (§5.7), phase-separated exactly like the Koa adapter: OUR
 * decision/serve/mutation errors degrade to pass-through + health flag; an
 * error thrown by the APP inside `next()` propagates untouched — never
 * swallowed, never re-run.
 */
import { combinedHeadEtag, type Decision, type SignalToBridge } from '../index.js';
import { HeadRewriter, type ManagedHead } from '../core/headRewriter.js';
import type { ControlRequest } from '../core/control.js';

export type FetchNext = () => Response | Promise<Response>;
export type FetchHandler = (request: Request, next?: FetchNext) => Promise<Response | undefined>;

const toControlRequest = (request: Request, controlPath: string, url: URL): ControlRequest => ({
  method: request.method,
  subPath: url.pathname.slice(controlPath.length) || '/',
  query: url.searchParams,
  header: (name) => request.headers.get(name) ?? undefined,
});

/** Applies set/remove to a clone of `response` — never mutates the original (immutable-headers safe). */
function withMutatedHeaders(response: Response, set: Record<string, string>, remove: readonly string[]): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(set)) headers.set(name, value);
  for (const name of remove) headers.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Auto-head for the fetch family (slice A1): the C-4 gate, the C-1 combined
 * ETag (we own revalidation), and the HeadRewriter over the response body
 * stream. In-handler compression is rare in fetch frameworks (platforms
 * compress AFTER the handler), so C-10 needs no request surgery here — an
 * already-encoded response simply fails the gate and passes through.
 */
async function transformHeadResponse(
  bridge: SignalToBridge,
  request: Request,
  response: Response,
  managed: Record<string, unknown>,
  stateVersion: number,
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  const eligible = response.status === 200
    && /text\/html/i.test(contentType)
    && (!/charset=/i.test(contentType) || /charset=["']?utf-?8/i.test(contentType))
    && response.headers.get('content-encoding') === null
    && response.body !== null;
  if (!eligible) return response;

  const appEtag = response.headers.get('etag');
  const ourEtag = combinedHeadEtag(stateVersion, appEtag);
  const inm = request.headers.get('if-none-match');
  if (inm !== null && ourEtag !== null && inm === ourEtag) {
    return new Response(null, { status: 304, headers: { etag: ourEtag } });
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('last-modified');
  if (ourEtag) headers.set('etag', ourEtag);
  else headers.delete('etag');

  if (request.method === 'HEAD') {
    // A HEAD response carries no body, so there is nothing to transform.
    // Taking a reader here and then dropping it left the upstream stream
    // LOCKED and undrained — on a fetch runtime that pins the underlying
    // connection until GC. Release it explicitly instead.
    void response.body.cancel();
    return new Response(null, { status: 200, statusText: response.statusText, headers });
  }

  const rewriter = new HeadRewriter(managed as ManagedHead);
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        try {
          for (const out of rewriter.end()) controller.enqueue(out);
        } catch {
          bridge.recordInternalError('autohead_end');
        }
        const outcome = rewriter.outcome();
        if (outcome.refusal) bridge.recordInternalError(`autohead_refused:${outcome.refusal}`);
        controller.close();
        return;
      }
      // Last-resort containment, mirroring the node handler: a throw in here
      // would ERROR the response stream, and the visitor would get a
      // truncated page from a connector bug. The rewriter contains its own
      // failures, so this is belt-and-braces — pass the app's bytes through.
      try {
        for (const out of rewriter.write(value)) controller.enqueue(out);
      } catch {
        bridge.recordInternalError('autohead_write');
        controller.enqueue(value);
      }
    },
    cancel(reason) { void reader.cancel(reason); },
  });

  return new Response(stream, { status: 200, statusText: response.statusText, headers });
}

export function createFetchHandler(bridge: SignalToBridge): FetchHandler {
  return async function signaltoBridgeFetch(request, next) {
    // Phase 1 — OUR decision. Any failure degrades to pass-through.
    let decision: Decision = { kind: 'pass' };
    let echo: Record<string, string> = {};
    let isControl = false;
    let url: URL | null = null;
    try {
      url = new URL(request.url);
      isControl = bridge.isControlPath(url.pathname);
      if (!isControl) {
        decision = bridge.decide(request.method, url.pathname);
        const probeNonce = url.searchParams.get('__signalto_probe');
        if (probeNonce) echo = await bridge.probeEchoHeader(probeNonce);
      }
    } catch {
      bridge.recordInternalError('fetch_decide');
      decision = { kind: 'pass' };
      echo = {};
      isControl = false;
    }

    // Phase 2a — control surface (single-runtime frameworks own it here).
    if (isControl && url) {
      try {
        const response = await bridge.handleControl(toControlRequest(request, bridge.controlPath, url));
        return new Response(response.body, { status: response.status, headers: response.headers });
      } catch {
        bridge.recordInternalError('fetch_control');
        return new Response('{"error":{"code":"internal"}}', { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Phase 2b — managed serve/redirect (ours; failure falls through to the app).
    if (decision.kind === 'respond') {
      try {
        const headers = { ...decision.headers, ...echo };
        // Consistency with the Next adapter (and kindness to strict runtimes):
        // managed redirect targets go absolute.
        if (decision.status >= 300 && decision.status < 400 && headers.location && headers.location.startsWith('/')) {
          headers.location = new URL(headers.location, request.url).toString();
        }
        return new Response(request.method === 'HEAD' ? null : decision.body, { status: decision.status, headers });
      } catch {
        bridge.recordInternalError('fetch_respond');
        // fall through to the app
      }
    }

    // Phase 3 — the APP. Its errors propagate untouched.
    if (!next) return undefined;
    const downstream = await next();

    // Phase 4a — auto-head transform (ours; failure returns the original).
    if (decision.kind === 'transform-head') {
      try {
        const transformed = await transformHeadResponse(bridge, request, downstream, decision.managed, decision.stateVersion);
        if (Object.keys(echo).length === 0) return transformed;
        return withMutatedHeaders(transformed, echo, []);
      } catch {
        bridge.recordInternalError('fetch_autohead');
        return downstream;
      }
    }

    // Phase 4b — OUR header mutations on a clone of the app's response.
    try {
      const set = decision.kind === 'mutate-headers' ? { ...decision.set, ...echo } : echo;
      const remove = decision.kind === 'mutate-headers' ? decision.remove : [];
      if (Object.keys(set).length === 0 && remove.length === 0) return downstream;
      return withMutatedHeaders(downstream, set, remove);
    } catch {
      bridge.recordInternalError('fetch_mutate');
      return downstream;
    }
  };
}
