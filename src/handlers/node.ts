/**
 * handlers/node.ts — the canonical (req, res, next) handler: works directly
 * as Express 4/5, Connect, or bare `http` middleware (plan §8).
 *
 * DO-NO-HARM WRAPPING (plan §5.7): every path is try/caught — any internal
 * error passes the request through untouched and raises a health flag. A
 * connector bug may cost us a managed path; it may never cost the customer a
 * request. The unmanaged fast path is fully synchronous: control-path check,
 * one/two Map lookups, one staleness compare, next().
 *
 * Header removal is the one invasive mechanism: an on-headers-style
 * writeHead patch, applied ONLY to requests whose path matched a header rule
 * — never globally (plan §5.7). Implemented in-repo (zero-dep) mirroring the
 * known-good pattern: the patch also normalizes a headers-object argument to
 * writeHead so removals cannot be resurrected by `writeHead(200, {...})`.
 * Node's implicit header send (`res.end()` without writeHead) routes through
 * ServerResponse.writeHead internally, so the patch covers it too.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { combinedHeadEtag, type SignalToBridge } from '../index.js';
import { HeadRewriter, type ManagedHead } from '../core/headRewriter.js';
import type { ControlRequest } from '../core/control.js';

type NextFunction = (err?: unknown) => void;

export type NodeHandler = (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void;

const PROBE_PARAM = '__signalto_probe';

function splitUrl(url: string): { path: string; search: string } {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return { path: url, search: '' };
  return { path: url.slice(0, qIdx), search: url.slice(qIdx + 1) };
}

/** Applies set/remove just before the head is committed — scoped to this response only. */
function patchWriteHead(res: ServerResponse, set: Record<string, string>, remove: readonly string[]): void {
  const original = res.writeHead.bind(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).writeHead = function patchedWriteHead(this: ServerResponse, ...args: any[]): ServerResponse {
    try {
      for (const [name, value] of Object.entries(set)) this.setHeader(name, value);
      for (const name of remove) this.removeHeader(name);
      // Headers passed directly to writeHead override setHeader/removeHeader
      // — normalize BOTH argument forms so removals stick and managed sets
      // win. The flat-array (raw-headers) form matters in the wild: h3 v2
      // commits its response head as writeHead(status, "", [name, value, …])
      // (found by the real-framework integration test).
      const last = args[args.length - 1];
      const removedLower = remove.map((name) => name.toLowerCase());
      const setLower = Object.keys(set).map((name) => name.toLowerCase());
      if (Array.isArray(last)) {
        const filtered: unknown[] = [];
        for (let i = 0; i + 1 < last.length; i += 2) {
          const name = String(last[i]).toLowerCase();
          if (removedLower.includes(name) || setLower.includes(name)) continue;
          filtered.push(last[i], last[i + 1]);
        }
        for (const [name, value] of Object.entries(set)) filtered.push(name, value);
        last.length = 0;
        last.push(...filtered);
      } else if (last && typeof last === 'object') {
        for (const key of Object.keys(last)) {
          const lower = key.toLowerCase();
          if (removedLower.includes(lower)) delete last[key];
          else if (setLower.includes(lower) && !(key in set)) delete last[key];
        }
        for (const [name, value] of Object.entries(set)) last[name] = value;
      }
    } catch {
      // Never let OUR patch break the response — fall through to the
      // original with whatever headers stand.
    }
    return original(...(args as Parameters<ServerResponse['writeHead']>));
  };
}

function sendResponse(
  res: ServerResponse,
  method: string,
  status: number,
  headers: Record<string, string>,
  body: string,
): void {
  res.writeHead(status, headers);
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

const toBuffer = (chunk: unknown, encoding?: unknown): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');

/**
 * Auto-head transform mode (slice A1).
 * Request side: C-10 (strip accept-encoding so in-process compression
 * disengages) and C-1 (we own revalidation — the app's conditional headers
 * never reach it). Response side, decided AT writeHead time: the C-4 gate
 * (only 200 + text/html + UTF-8 transforms; everything else re-attaches the
 * original behavior), the C-1 combined ETag (304 only when BOTH the head
 * state and the app's own validator match), and the HeadRewriter stream
 * (which itself enforces C-2/C-3/C-6/C-14 — a refusal emits the ORIGINAL
 * bytes and raises a health flag; the response is never corrupted).
 */
function applyHeadTransform(
  bridge: SignalToBridge,
  req: IncomingMessage,
  res: ServerResponse,
  managed: Record<string, unknown>,
  stateVersion: number,
  next: NextFunction,
): void {
  const inm = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : null;
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  delete req.headers['accept-encoding']; // C-10

  const rewriter = new HeadRewriter(managed as ManagedHead);
  const origWriteHead = res.writeHead.bind(res);
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  let mode: 'pending' | 'transform' | 'suppress-304' | 'passthrough' = 'pending';

  const decide = (statusCode: number, headersArg: Record<string, unknown> | null): void => {
    const headerOf = (name: string): string | null => {
      if (headersArg) {
        for (const key of Object.keys(headersArg)) {
          if (key.toLowerCase() === name) return String(headersArg[key]);
        }
      }
      const direct = res.getHeader(name);
      return direct === undefined ? null : String(direct);
    };
    const contentType = headerOf('content-type') ?? '';
    // C-4 gate. The content-encoding arm matches handlers/fetch.ts: an app
    // that already compressed (or otherwise encoded) its own response hands
    // us bytes the rewriter cannot read — transforming them would emit
    // corrupt output, so such a response passes through UNTOUCHED, keeping
    // its encoding header and its body.
    const contentEncoding = headerOf('content-encoding');
    const eligible = statusCode === 200
      && /text\/html/i.test(contentType)
      && (!/charset=/i.test(contentType) || /charset=["']?utf-?8/i.test(contentType))
      && (contentEncoding === null || /^identity$/i.test(contentEncoding.trim()));
    if (!eligible) { mode = 'passthrough'; return; }

    const appEtag = headerOf('etag');
    const ourEtag = combinedHeadEtag(stateVersion, appEtag);
    if (inm !== null && ourEtag !== null && inm === ourEtag) {
      mode = 'suppress-304';
      origWriteHead(304, { etag: ourEtag });
      return;
    }
    mode = 'transform';
    for (const name of ['content-length', 'last-modified', 'content-encoding', 'etag']) {
      res.removeHeader(name);
      if (headersArg) {
        for (const key of Object.keys(headersArg)) {
          if (key.toLowerCase() === name) delete headersArg[key];
        }
      }
    }
    if (ourEtag) res.setHeader('etag', ourEtag);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).writeHead = function patchedWriteHead(this: ServerResponse, ...args: any[]): ServerResponse {
    if (mode === 'pending') {
      const last = args[args.length - 1];
      const headersArg = last && typeof last === 'object' && !Array.isArray(last) ? (last as Record<string, unknown>) : null;
      try {
        decide(typeof args[0] === 'number' ? args[0] : this.statusCode, headersArg);
      } catch {
        bridge.recordInternalError('autohead_decide');
        mode = 'passthrough';
      }
    }
    if (mode === 'suppress-304') return this; // 304 head already committed
    return origWriteHead(...(args as Parameters<ServerResponse['writeHead']>));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).write = function patchedWrite(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (mode === 'pending') {
      // Implicit head-send path: writing triggers writeHead via node's
      // _implicit_header, which routes through the patch above.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).writeHead(res.statusCode);
    }
    if (mode === 'suppress-304') { if (typeof cb === 'function') (cb as () => void)(); return true; }
    if (mode !== 'transform') return origWrite(chunk as never, encoding as never, callback as never);
    const enc = typeof encoding === 'function' ? undefined : encoding;
    try {
      const outs = rewriter.write(toBuffer(chunk, encoding));
      if (outs.length === 0) {
        // Still buffering the head (bounded by HEAD_CAP_BYTES): we have taken
        // the bytes, so the write IS accepted and `true` is honest — there is
        // no socket pressure to report yet, and the callback fires now
        // because the caller's chunk is fully consumed.
        if (typeof cb === 'function') (cb as () => void)();
        return true;
      }
      // Head flushed — from here we are a pass-through, so the socket's own
      // backpressure signal must reach the app verbatim. Returning a blanket
      // `true` told a streaming renderer to keep pushing into a full socket;
      // the completion callback belongs on the LAST underlying write, so
      // "drained" means drained rather than "handed to us".
      let accepted = true;
      for (let i = 0; i < outs.length; i += 1) {
        const isLast = i === outs.length - 1;
        accepted = isLast && typeof cb === 'function'
          ? origWrite(outs[i]!, cb as () => void)
          : origWrite(outs[i]!);
      }
      return accepted;
    } catch {
      bridge.recordInternalError('autohead_write');
      return origWrite(chunk as never, enc as never, cb as never);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).end = function patchedEnd(chunk?: unknown, encoding?: unknown, callback?: unknown): ServerResponse {
    const cb = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
    const dataChunk = typeof chunk === 'function' ? undefined : chunk;
    if (dataChunk !== undefined && dataChunk !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).write(dataChunk, typeof encoding === 'function' ? undefined : encoding);
    } else if (mode === 'pending') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).writeHead(res.statusCode);
    }
    if (mode === 'transform') {
      try {
        for (const out of rewriter.end()) origWrite(out);
        const outcome = rewriter.outcome();
        if (outcome.refusal) bridge.recordInternalError(`autohead_refused:${outcome.refusal}`);
      } catch {
        bridge.recordInternalError('autohead_end');
      }
    }
    return origEnd(typeof cb === 'function' ? (cb as () => void) : undefined);
  };

  next();
}

function toControlRequest(req: IncomingMessage, controlPath: string, path: string, search: string): ControlRequest {
  return {
    method: req.method ?? 'GET',
    subPath: path.slice(controlPath.length) || '/',
    query: new URLSearchParams(search),
    header: (name: string) => {
      const value = req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
}

export function createNodeHandler(bridge: SignalToBridge): NodeHandler {
  return function signaltoBridgeMiddleware(req, res, next) {
    try {
      const method = req.method ?? 'GET';
      const { path, search } = splitUrl(req.url ?? '/');

      // Control surface — exact-prefix only; everything else never pays for it.
      if (bridge.isControlPath(path)) {
        const controlRequest = toControlRequest(req, bridge.controlPath, path, search);
        bridge.handleControl(controlRequest)
          .then((response) => sendResponse(res, method, response.status, response.headers, response.body))
          .catch(() => {
            bridge.recordInternalError('control');
            if (!res.headersSent) sendResponse(res, method, 500, { 'content-type': 'application/json' }, '{"error":{"code":"internal"}}');
            else res.end();
          });
        return;
      }

      const decision = bridge.decide(method, path);

      // The probe overlay is the ONLY async step outside the control surface,
      // and only when the probe param is genuinely present (cheap substring
      // check first — the normal hot path never parses the query string).
      const probeNonce = search !== '' && search.includes(PROBE_PARAM)
        ? new URLSearchParams(search).get(PROBE_PARAM)
        : null;

      if (probeNonce) {
        bridge.probeEchoHeader(probeNonce)
          .then((echo) => {
            try {
              if (decision.kind === 'respond') {
                sendResponse(res, method, decision.status, { ...decision.headers, ...echo }, decision.body);
                return;
              }
              if (decision.kind === 'mutate-headers') {
                patchWriteHead(res, { ...decision.set, ...echo }, decision.remove);
                next();
                return;
              }
              // pass (echo still attached — probing '/' proves interception
              // even when nothing is managed there yet)
              patchWriteHead(res, echo, []);
              next();
            } catch {
              bridge.recordInternalError('probe_dispatch');
              if (!res.headersSent) next();
            }
          })
          .catch(() => {
            bridge.recordInternalError('probe_echo');
            if (!res.headersSent) next();
          });
        return;
      }

      switch (decision.kind) {
        case 'respond':
          sendResponse(res, method, decision.status, decision.headers, decision.body);
          return;
        case 'mutate-headers':
          patchWriteHead(res, decision.set, decision.remove);
          next();
          return;
        case 'transform-head':
          applyHeadTransform(bridge, req, res, decision.managed, decision.stateVersion, next);
          return;
        default:
          next();
          return;
      }
    } catch {
      bridge.recordInternalError('middleware');
      try {
        next();
      } catch {
        // A throwing next() is the app's own failure mode — nothing left for us to do safely.
      }
    }
  };
}
