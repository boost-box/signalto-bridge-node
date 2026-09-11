/**
 * adapters/next.ts — the Next.js App Router mount (plan §5.5/§8, spike S-5).
 *
 * Next splits across TWO runtimes, and the bridge respects that split:
 *
 *   1. `middleware.ts` (Edge runtime on Vercel — WinterCG core only): the
 *      serving layer for robots/root files/redirects/headers + probe echo.
 *   2. `app/api/signalto/[...op]/route.ts` (Node runtime): the control
 *      surface — because ONLY a route handler can call `revalidatePath()`,
 *      the S-5 hook that makes slot changes appear on ISR/static routes
 *      without a redeploy (L-N13). NOTE the path: App Router treats
 *      underscore-prefixed directories as PRIVATE (unroutable), so the
 *      default `/__signalto` cannot be a route handler — set
 *      `controlPath: '/api/signalto'` on the bridge and mount there (live
 *      UAT finding).
 *   3. Server components / `generateMetadata`: the slot helpers.
 *
 * Each runtime instantiates its own bridge from a shared `lib/signalto.ts`
 * (module instances do not cross the boundary; both pull the same engine
 * state — the multi-instance model the bridge already assumes).
 *
 * ZERO next imports (D-9 zero-dep): everything Next-specific is INJECTED —
 * the middleware takes a `makeNext` factory (pass `() => NextResponse.next()`)
 * and the route-handler factory takes `revalidatePath` (pass the export of
 * 'next/cache'). Fully testable with plain Request/Response.
 *
 * middleware.ts:
 *   import { NextResponse } from 'next/server';
 *   import { bridge } from './lib/signalto';
 *   import { signaltoNextMiddleware } from '@signalto/bridge-node/next';
 *   const handle = signaltoNextMiddleware(bridge);
 *   export async function middleware(req: Request) {
 *     return handle(req, () => NextResponse.next());
 *   }
 *   export const config = { matcher: ['/robots.txt', '/llms.txt', '/.well-known/:path*', '/__signalto/:path*'] };
 *   // Broaden the matcher only if you want site-wide redirects/headers —
 *   // middleware invocations are billed per request on Vercel (L-N16).
 *
 * app/api/signalto/[...op]/route.ts:
 *   import { revalidatePath } from 'next/cache';
 *   import { bridge } from '@/lib/signalto';   // createBridge({ controlPath: '/api/signalto', slots: [...] })
 *   import { signaltoNextRouteHandlers } from '@signalto/bridge-node/next';
 *   export const { GET, POST } = signaltoNextRouteHandlers(bridge, { revalidatePath });
 */
import { SignalToBridge } from '../index.js';
import type { ControlRequest } from '../core/control.js';

const toControlRequest = (request: Request, controlPath: string): ControlRequest => {
  const url = new URL(request.url);
  return {
    method: request.method,
    subPath: url.pathname.slice(controlPath.length) || '/',
    query: url.searchParams,
    header: (name) => request.headers.get(name) ?? undefined,
  };
};

/**
 * The Edge-runtime middleware handler. Returns:
 *   - a Response for managed serves/redirects (and the control surface, if
 *     the matcher routes it here rather than to the route handler);
 *   - `makeNext()` with managed headers applied, for header rules/probes;
 *   - `undefined` (= Next continues) when nothing is managed on the path.
 */
export function signaltoNextMiddleware(bridge: SignalToBridge) {
  return async function middleware(
    request: Request,
    makeNext?: () => Response,
  ): Promise<Response | undefined> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // On Next the control surface belongs to the ROUTE HANDLER (Node
      // runtime) — the only place revalidatePath is callable. The middleware
      // (Edge runtime, its own bridge instance with no revalidation hook)
      // must NOT answer control calls, or the engine pairs/refreshes/reads
      // against an instance the rendered pages never see. Live UAT finding:
      // exactly that happened — refresh pings refreshed the edge instance,
      // revalidatePath never ran, and slot applies verified against the
      // wrong runtime. Pass control paths through to routing.
      if (bridge.isControlPath(path)) return undefined;

      const decision = bridge.decide(request.method, path);
      const probeNonce = url.searchParams.get('__signalto_probe');
      const echo = probeNonce ? await bridge.probeEchoHeader(probeNonce) : {};

      if (decision.kind === 'respond') {
        // Live UAT finding: Next's middleware adapter rejects a 3xx whose
        // Location is relative (`new URL('/x')` throws ERR_INVALID_URL) —
        // absolutize managed redirect targets against the request URL.
        const headers = { ...decision.headers, ...echo };
        if (decision.status >= 300 && decision.status < 400 && headers.location && headers.location.startsWith('/')) {
          headers.location = new URL(headers.location, request.url).toString();
        }
        return new Response(request.method === 'HEAD' ? null : decision.body, {
          status: decision.status,
          headers,
        });
      }

      const set = decision.kind === 'mutate-headers' ? { ...decision.set, ...echo } : echo;
      const remove = decision.kind === 'mutate-headers' ? decision.remove : [];
      if (Object.keys(set).length === 0 && remove.length === 0) return undefined;
      if (!makeNext) return undefined; // header rules need the NextResponse factory — degrade honestly (the probe then fails and capabilities report it)
      const next = makeNext();
      for (const [name, value] of Object.entries(set)) next.headers.set(name, value);
      for (const name of remove) next.headers.delete(name);
      return next;
    } catch {
      bridge.recordInternalError('next_middleware');
      return undefined; // pass through untouched (§5.7)
    }
  };
}

export interface NextRouteHandlerHooks {
  /** Pass `revalidatePath` from 'next/cache' — wired as the slot-change revalidation callback (S-5). */
  readonly revalidatePath?: (path: string) => void;
}

/**
 * The Node-runtime control surface as App Router route handlers. Mount at
 * `app/api/signalto/[...op]/route.ts` — matching the `controlPath:
 * '/api/signalto'` the bridge is configured with, because the App Router
 * cannot route an underscore-prefixed directory. Wiring `revalidatePath` here
 * is what flips static/ISR slots from `static_render_no_revalidation` to editable —
 * the connector reports `revalidate: true` once the hook is set.
 */
export function signaltoNextRouteHandlers(bridge: SignalToBridge, hooks: NextRouteHandlerHooks = {}) {
  if (hooks.revalidatePath) {
    const revalidate = hooks.revalidatePath;
    bridge.setOnSlotsChanged((paths) => {
      for (const path of paths) revalidate(path);
    });
  }

  const handle = async (request: Request): Promise<Response> => {
    try {
      const response = await bridge.handleControl(toControlRequest(request, bridge.controlPath));
      return new Response(response.body, { status: response.status, headers: response.headers });
    } catch {
      bridge.recordInternalError('next_route_handler');
      return new Response('{"error":{"code":"internal"}}', { status: 500, headers: { 'content-type': 'application/json' } });
    }
  };

  return { GET: handle, POST: handle };
}

/**
 * Slot helpers for server components / generateMetadata. Async
 * (cold-start-tolerant, capped wait — an engine outage renders the wired
 * fallback, never a hung page):
 *
 *   export async function generateMetadata() {
 *     return signaltoMeta(bridge, 'how-it-works', { title: 'How it works' });
 *   }
 */
export async function signaltoMeta<T extends Record<string, string>>(
  bridge: SignalToBridge,
  name: string,
  fallback: T,
): Promise<T> {
  const managed = await bridge.slotAsync<Partial<T> | null>('meta', name, null);
  return managed ? { ...fallback, ...managed } : fallback;
}

export async function signaltoSchema(
  bridge: SignalToBridge,
  name: string,
  fallback: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return bridge.slotAsync('schema', name, fallback);
}

export async function signaltoContent(
  bridge: SignalToBridge,
  name: string,
  fallback: string,
): Promise<string> {
  return bridge.slotAsync('content', name, fallback);
}

export { SignalToBridge };
export { createBridge } from '../index.js';
export type { BridgeOptions } from '../index.js';
