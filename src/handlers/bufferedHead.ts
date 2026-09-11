/**
 * handlers/bufferedHead.ts — the auto-head transform for adapters that hand
 * us the WHOLE response body at once instead of a stream: Fastify's `onSend`
 * payload and Koa's `ctx.body`. Both frameworks buffer by design, so there is
 * nothing to stream and the writeHead patch the node handler needs would be
 * both invasive and pointless on them.
 *
 * Same rewriter, same rules as handlers/node.ts and handlers/fetch.ts — the
 * C-4 gate (200 + text/html + UTF-8 + no content-encoding), the C-1 combined
 * ETag (we own revalidation), and HeadRewriter itself (C-2/C-3/C-6/C-14). A
 * refusal is reported as a PASSTHROUGH so the caller leaves the response
 * exactly as the app built it — headers included; a buffered adapter has no
 * reason to strip validators from a response it then hands back untouched.
 *
 * Content-length is deliberately not our problem here: Fastify recomputes it
 * from the final payload after the onSend hooks, and Koa derives it from
 * ctx.body — both are correct for the replaced body, and a 304/empty status
 * drops it entirely.
 */
import { combinedHeadEtag } from '../index.js';
import { HeadRewriter, type HeadRefusal, type ManagedHead } from '../core/headRewriter.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export interface BufferedHeadRequest {
  readonly method: string;
  /** The client's validator, BEFORE the adapter strips it from the app (C-1). */
  readonly ifNoneMatch: string | null;
}

export interface BufferedHeadResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  /** The app's own validator, if it set one. */
  readonly etag: string | null;
  /** The buffered body: a string or bytes. Anything else (a stream) is reported unsupported. */
  readonly payload: unknown;
}

export type BufferedHeadResult =
  /** Leave the response completely alone. `refusal` / `unsupportedPayload` are health-flag material. */
  | { readonly kind: 'passthrough'; readonly refusal?: HeadRefusal; readonly unsupportedPayload?: boolean }
  | { readonly kind: 'not-modified'; readonly etag: string }
  | { readonly kind: 'transform'; readonly body: string; readonly etag: string | null };

/** The C-4 gate, shared verbatim with the streaming handlers. */
export function isHeadTransformEligible(response: BufferedHeadResponse): boolean {
  const contentType = response.contentType ?? '';
  return response.status === 200
    && /text\/html/i.test(contentType)
    && (!/charset=/i.test(contentType) || /charset=["']?utf-?8/i.test(contentType))
    && (response.contentEncoding === null || /^identity$/i.test(response.contentEncoding.trim()));
}

function toBytes(payload: unknown): Uint8Array | null {
  if (typeof payload === 'string') return encoder.encode(payload);
  if (payload instanceof Uint8Array) return payload;
  return null;
}

/**
 * Decides what a buffered adapter should do with one response. Pure — the
 * caller applies the outcome with its own framework's API.
 */
export function transformBufferedHead(
  request: BufferedHeadRequest,
  response: BufferedHeadResponse,
  managed: ManagedHead,
  stateVersion: number,
): BufferedHeadResult {
  if (!isHeadTransformEligible(response)) return { kind: 'passthrough' };

  const bytes = toBytes(response.payload);
  if (bytes === null) return { kind: 'passthrough', unsupportedPayload: true };

  const ourEtag = combinedHeadEtag(stateVersion, response.etag);
  if (request.ifNoneMatch !== null && ourEtag !== null && request.ifNoneMatch === ourEtag) {
    return { kind: 'not-modified', etag: ourEtag };
  }

  const rewriter = new HeadRewriter(managed);
  const out = [...rewriter.write(bytes), ...rewriter.end()];
  const outcome = rewriter.outcome();
  if (!outcome.transformed) {
    return outcome.refusal ? { kind: 'passthrough', refusal: outcome.refusal } : { kind: 'passthrough' };
  }

  let total = 0;
  for (const chunk of out) total += chunk.byteLength;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of out) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'transform', body: decoder.decode(joined), etag: ourEtag };
}
