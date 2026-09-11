/**
 * adapters/fastify.ts — the Fastify mount (plan §8):
 *
 *   import { signaltoFastify } from '@signalto/bridge-node/fastify';
 *   await app.register(signaltoFastify());   // FIRST plugin registered
 *
 * Uses Fastify's native hooks instead of the writeHead patch: `onRequest`
 * decides (respond/redirect/pass), `onSend` applies header set/remove just
 * before the head commits — no monkey-patching needed on this framework.
 * Same do-no-harm contract as every handler: any internal error passes the
 * request through untouched + health flag; typed as structurally-Fastify
 * (no fastify import — zero runtime deps; the instance shape is narrow).
 *
 * AUTO-HEAD also runs on `onSend`: Fastify buffers the payload, so the shared
 * buffered-head transform replaces the string/Buffer body in place — same
 * gate, same rewriter, same combined ETag as the node and fetch handlers.
 * Fastify recomputes content-length from the payload we return, so the
 * rewritten body is always correctly framed. A payload we cannot read (a
 * stream) is a health-flagged pass-through, never a corrupted response.
 */
import { createBridge, SignalToBridge, type BridgeOptions, type Decision } from '../index.js';
import type { ControlRequest } from '../core/control.js';
import { transformBufferedHead } from '../handlers/bufferedHead.js';
import type { ManagedHead } from '../core/headRewriter.js';

/** The narrow structural slice of FastifyInstance/Request/Reply this plugin touches — keeps fastify out of our dependency graph. */
interface FastifyishReply {
  raw: { setHeader(name: string, value: string): void; removeHeader(name: string): void; statusCode?: number };
  header(name: string, value: string): unknown;
  removeHeader?(name: string): unknown;
  getHeader?(name: string): unknown;
  statusCode?: number;
  code(status: number): unknown;
  send(body?: unknown): unknown;
  hijack?(): unknown;
}
interface FastifyishRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}
interface FastifyishInstance {
  addHook(name: 'onRequest', hook: (request: FastifyishRequest, reply: FastifyishReply) => Promise<unknown>): unknown;
  addHook(name: 'onSend', hook: (request: FastifyishRequest, reply: FastifyishReply, payload: unknown) => Promise<unknown>): unknown;
  decorateRequest?(name: string, value: unknown): unknown;
}

interface PendingHeadTransform {
  managed: ManagedHead;
  stateVersion: number;
  /** Captured in onRequest, because C-1 strips it from the app's view of the request. */
  ifNoneMatch: string | null;
}

interface PendingHeaderMutation {
  set: Record<string, string>;
  remove: readonly string[];
  head?: PendingHeadTransform;
}

const headerString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? String(value[0]) : String(value);
};

const splitUrl = (url: string): { path: string; search: string } => {
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? { path: url, search: '' } : { path: url.slice(0, qIdx), search: url.slice(qIdx + 1) };
};

/**
 * Runs the buffered auto-head transform against a Fastify reply, returning
 * the payload to send. Every outcome except `transform` returns the app's own
 * payload untouched — a refusal or an unreadable payload costs us the
 * transform, never the response.
 */
function applyHeadTransform(
  bridge: SignalToBridge,
  request: FastifyishRequest,
  reply: FastifyishReply,
  head: PendingHeadTransform,
  payload: unknown,
): unknown {
  const readHeader = (name: string): string | null =>
    headerString(typeof reply.getHeader === 'function' ? reply.getHeader(name) : undefined);
  const status = reply.statusCode ?? reply.raw.statusCode ?? 200;
  const result = transformBufferedHead(
    { method: request.method ?? 'GET', ifNoneMatch: head.ifNoneMatch },
    {
      status,
      contentType: readHeader('content-type'),
      contentEncoding: readHeader('content-encoding'),
      etag: readHeader('etag'),
      payload,
    },
    head.managed,
    head.stateVersion,
  );

  if (result.kind === 'passthrough') {
    if (result.refusal) bridge.recordInternalError(`autohead_refused:${result.refusal}`);
    else if (result.unsupportedPayload) bridge.recordInternalError('autohead_unsupported_payload');
    return payload;
  }
  if (result.kind === 'not-modified') {
    reply.code(304);
    reply.header('etag', result.etag);
    // Fastify only drops a body for <200/204, so the 304 must carry a null
    // payload of our own making; it then sends no content-length either.
    return null;
  }

  // last-modified would out-live the head state it no longer describes.
  if (typeof reply.removeHeader === 'function') reply.removeHeader('last-modified');
  else reply.raw.removeHeader('last-modified');
  if (result.etag) reply.header('etag', result.etag);
  else if (typeof reply.removeHeader === 'function') reply.removeHeader('etag');
  // HEAD returns the transformed body too: node suppresses the bytes for a
  // HEAD response, so this only serves to frame content-length off the real
  // transformed length rather than the app's pre-transform one.
  return result.body;
}

export interface FastifyBridgePlugin {
  (instance: FastifyishInstance, opts: unknown, done: (err?: Error) => void): void;
  readonly bridge: SignalToBridge;
}

export function signaltoFastify(options: BridgeOptions = {}): FastifyBridgePlugin {
  const bridge = createBridge(options);
  const pending = new WeakMap<object, PendingHeaderMutation>();

  const plugin = function signaltoBridgePlugin(instance: FastifyishInstance, _opts: unknown, done: (err?: Error) => void): void {
    instance.addHook('onRequest', async (request, reply) => {
      try {
        const method = request.method ?? 'GET';
        const { path, search } = splitUrl(request.url ?? '/');

        if (bridge.isControlPath(path)) {
          const controlRequest: ControlRequest = {
            method,
            subPath: path.slice(bridge.controlPath.length) || '/',
            query: new URLSearchParams(search),
            header: (name) => {
              const value = request.headers[name.toLowerCase()];
              return Array.isArray(value) ? value[0] : value;
            },
          };
          const response = await bridge.handleControl(controlRequest);
          reply.code(response.status);
          for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
          reply.send(response.body);
          // Returning the reply is Fastify's signal that the hook has
          // completed the response — routing/handlers are skipped.
          return reply;
        }

        const decision: Decision = bridge.decide(method, path);
        const probeNonce = search !== '' && search.includes('__signalto_probe')
          ? new URLSearchParams(search).get('__signalto_probe')
          : null;
        const echo = probeNonce ? await bridge.probeEchoHeader(probeNonce) : {};

        if (decision.kind === 'respond') {
          reply.code(decision.status);
          for (const [name, value] of Object.entries({ ...decision.headers, ...echo })) reply.header(name, value);
          reply.send(method === 'HEAD' ? '' : decision.body);
          return reply;
        }
        if (decision.kind === 'transform-head') {
          // C-1: we own revalidation, so the app never sees the conditional
          // headers. C-10: no accept-encoding means in-process compression
          // disengages and onSend gets readable bytes.
          const ifNoneMatch = headerString(request.headers['if-none-match']);
          delete request.headers['if-none-match'];
          delete request.headers['if-modified-since'];
          delete request.headers['accept-encoding'];
          pending.set(request as object, {
            set: echo,
            remove: [],
            head: { managed: decision.managed as ManagedHead, stateVersion: decision.stateVersion, ifNoneMatch },
          });
          return;
        }
        const mutation: PendingHeaderMutation | null = decision.kind === 'mutate-headers'
          ? { set: { ...decision.set, ...echo }, remove: decision.remove }
          : Object.keys(echo).length > 0
          ? { set: echo, remove: [] }
          : null;
        if (mutation) pending.set(request as object, mutation);
        // pass — fall through to the app's own routing.
      } catch {
        bridge.recordInternalError('fastify_onRequest');
        // pass through untouched (§5.7).
      }
    });

    instance.addHook('onSend', async (request, reply, payload) => {
      let outgoing = payload;
      try {
        const mutation = pending.get(request as object);
        if (mutation) {
          if (mutation.head) {
            outgoing = applyHeadTransform(bridge, request, reply, mutation.head, payload);
          }
          for (const [name, value] of Object.entries(mutation.set)) reply.header(name, value);
          for (const name of mutation.remove) {
            if (typeof reply.removeHeader === 'function') reply.removeHeader(name);
            else reply.raw.removeHeader(name);
          }
        }
      } catch {
        bridge.recordInternalError('fastify_onSend');
        return payload; // never ship a half-applied response
      }
      return outgoing;
    });

    done();
  } as FastifyBridgePlugin;

  // The documented fastify-plugin mechanism, without the dependency: this
  // symbol tells Fastify NOT to encapsulate the plugin, so the hooks apply
  // to the WHOLE app (including its 404 context) — exactly what
  // fastify-plugin itself sets.
  (plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
  Object.defineProperty(plugin, 'bridge', { value: bridge, enumerable: false });
  return plugin;
}

export { createBridge, SignalToBridge };
export type { BridgeOptions };
