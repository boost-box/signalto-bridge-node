/**
 * headRewriter.ts — the production auto-head transform (slice A1), promoted
 * from the S-6 spike after it went 21/21.
 *
 * Design (D-A4, simplified by S-6): buffer the response until `</head>`
 * (capped, C-6), process the head as ONE string with a small
 * attribute-aware tokenizer (not regexes — the spike's carried-forward
 * hardening), emit the rewritten head, then stream every later byte through
 * RAW. The body is never parsed, never touched.
 *
 * C-rules implemented here:
 *   C-2  field-GROUP replace-not-append: title group (title/og:title/
 *        twitter:title), description group, canonical (replace-only), each
 *        managed as an atomic unit; duplicates removed.
 *   C-3  JSON-LD nonce copy (belt-and-suspenders — S-6 B7 proved data
 *        blocks are CSP-exempt in Chrome; the nonce costs nothing).
 *   C-6  cap: an unclosed head passes through UNTRANSFORMED + flagged.
 *   C-14 React-hydration refusal — S-6's headline: React 19 re-owns the
 *        hydrated head, so Googlebot (which renders JS) would see the app
 *        head + a duplicated canonical. React-family pages are DETECTED and
 *        REFUSED (`react_hydration_owns_head`). Detection uses HEAD-visible
 *        signals — `/_next/` and `/_nuxt/` asset URLs in a src/href, the
 *        framework globals (`__NEXT_DATA__`, `__next_f`, `__NUXT__`,
 *        `window.__nuxt`, `__sveltekit`) inside an inline script body, and
 *        `data-sveltekit-*` attributes — because the flight payload proper
 *        arrives in the body, after the head must be emitted. Each signal is
 *        matched WHERE the framework plants it, not anywhere in the head, so
 *        prose that merely names one does not cost a page its transform. The
 *        ENGINE also probes the full page at preview time (body markers
 *        included) — this guard is defense in depth, not the only gate.
 *
 * The C-4 transform gate (status/content-type/charset) and C-1/C-10 header
 * work live in the HANDLERS — this module only ever sees eligible bodies.
 *
 * WinterCG-only by construction: Uint8Array + TextEncoder/TextDecoder, no
 * node:buffer — the fetch handler mounts this on edge runtimes where `Buffer`
 * does not exist unless nodejs_compat is enabled.
 */

export interface ManagedHead {
  readonly title?: string;
  readonly description?: string;
  readonly canonical?: string;
  readonly jsonLd?: Record<string, unknown>;
}

export const HEAD_CAP_BYTES = 64 * 1024;

export type HeadRefusal = 'react_hydration_owns_head' | 'head_cap_exceeded' | 'no_head_found' | 'rewrite_failed';

// ---------------------------------------------------------------------------
// Tokenizer — attribute-aware scan of the head string. Bounded grammar: we
// only ever need tag name + attributes + ranges; nesting is irrelevant in
// the head. Malformed markup degrades to "tag not recognized" (skipped),
// never a throw.
// ---------------------------------------------------------------------------

interface HeadTag {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  /** Byte-range [start, end) of the ENTIRE tag in the head string. */
  readonly start: number;
  readonly end: number;
  readonly isClose: boolean;
}

const NAME_CHAR = /[a-zA-Z0-9-]/;

export function tokenizeHead(head: string): HeadTag[] {
  const tags: HeadTag[] = [];
  let i = 0;
  while (i < head.length) {
    const lt = head.indexOf('<', i);
    if (lt === -1) break;
    let cursor = lt + 1;
    // Comments: skip to their close so a commented-out tag never matches.
    if (head.startsWith('!--', cursor)) {
      const close = head.indexOf('-->', cursor);
      i = close === -1 ? head.length : close + 3;
      continue;
    }
    const isClose = head[cursor] === '/';
    if (isClose) cursor += 1;
    let name = '';
    while (cursor < head.length && NAME_CHAR.test(head[cursor]!)) {
      name += head[cursor]!.toLowerCase();
      cursor += 1;
    }
    if (name === '') { i = lt + 1; continue; }

    const attrs = new Map<string, string>();
    // Attribute scan until the tag's own '>' (attribute values may contain
    // '>' only when quoted — handled by consuming quoted spans whole).
    while (cursor < head.length && head[cursor] !== '>') {
      const ch = head[cursor]!;
      if (/\s|\//.test(ch)) { cursor += 1; continue; }
      let attrName = '';
      while (cursor < head.length && /[^\s=/>]/.test(head[cursor]!)) {
        attrName += head[cursor]!.toLowerCase();
        cursor += 1;
      }
      while (cursor < head.length && /\s/.test(head[cursor]!)) cursor += 1;
      let value = '';
      if (head[cursor] === '=') {
        cursor += 1;
        while (cursor < head.length && /\s/.test(head[cursor]!)) cursor += 1;
        const quote = head[cursor];
        if (quote === '"' || quote === "'") {
          const closeQuote = head.indexOf(quote, cursor + 1);
          if (closeQuote === -1) { cursor = head.length; break; }
          value = head.slice(cursor + 1, closeQuote);
          cursor = closeQuote + 1;
        } else {
          while (cursor < head.length && /[^\s>]/.test(head[cursor]!)) {
            value += head[cursor]!;
            cursor += 1;
          }
        }
      }
      if (attrName !== '') attrs.set(attrName, value);
    }
    if (cursor >= head.length) break; // unterminated tag at buffer end — leave untouched
    tags.push({ name, attrs, start: lt, end: cursor + 1, isClose });
    // <script>/<style> raw-text contents must not be tokenized as markup.
    if (!isClose && (name === 'script' || name === 'style')) {
      const rawClose = head.toLowerCase().indexOf(`</${name}`, cursor + 1);
      i = rawClose === -1 ? head.length : rawClose;
    } else {
      i = cursor + 1;
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Head rewrite — range-edit based, single pass over the token list.
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Serializes JSON-LD for a <script> block. `</` escaping alone left three
 * ways to break out of the block or change how the parser reads it: a bare
 * `<` opening `<!--` (which switches the tokenizer to script-data-escaped and
 * swallows the rest of the head), `>` closing a `-->`, and `<script` nesting.
 * EVERY `<`, `>` and `&` is therefore escaped.
 *
 * The escape is the JSON \uXXXX form, NOT an HTML entity: a script block is
 * raw text, so entities are not decoded there and `&lt;` would reach a
 * consumer as those four literal characters instead of the character the
 * customer typed. The \u form is valid JSON that parses back to exactly the
 * original character, so the data round-trips while being inert as markup.
 */
function serializeJsonLd(value: Record<string, unknown>): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * Bundler asset prefixes that only ever appear in a script/link URL. Matched
 * against src/href attribute VALUES, never against the head as free text.
 */
const CLIENT_ASSET_MARKERS = ['/_next/', '/_nuxt/'] as const;

/**
 * Client-head-ownership globals. Matched inside inline <script> bodies (where
 * a framework plants them) — not against prose, comments or a managed
 * description that happens to mention the name.
 */
const CLIENT_HEAD_GLOBALS = ['__NEXT_DATA__', '__next_f', '__NUXT__', 'window.__nuxt', '__sveltekit'] as const;

/** Extracts the raw text of every inline <script> in the head — tokenizeHead deliberately skips script contents as markup. */
function inlineScriptBodies(head: string, tags: readonly HeadTag[]): string[] {
  const bodies: string[] = [];
  const lower = head.toLowerCase();
  for (const tag of tags) {
    if (tag.isClose || tag.name !== 'script') continue;
    const close = lower.indexOf('</script', tag.end);
    bodies.push(close === -1 ? head.slice(tag.end) : head.slice(tag.end, close));
  }
  return bodies;
}

/**
 * HEAD-visible client-head-ownership signals (C-14): React family (Next),
 * Nuxt, and SvelteKit (fail-closed pending its own check). The engine's
 * full-page probe is the primary gate; this is the in-band guard.
 *
 * ANCHORED, not substring: a signal counts only where the framework actually
 * plants it — an asset URL in a src/href attribute, a global in an inline
 * script body, or a `data-sveltekit-*` attribute. A bare `head.includes()`
 * refused any page whose managed description or prose happened to contain
 * `/_next/`, which is a silent loss of a page we could have managed.
 */
export function headSignalsReactHydration(head: string): boolean {
  let tags: readonly HeadTag[];
  try {
    tags = tokenizeHead(head);
  } catch {
    return true; // cannot read the head => cannot prove it is safe to transform
  }
  for (const tag of tags) {
    if (tag.isClose) continue;
    for (const [name, value] of tag.attrs) {
      if (name.startsWith('data-sveltekit')) return true;
      if ((name === 'src' || name === 'href') && CLIENT_ASSET_MARKERS.some((marker) => value.includes(marker))) return true;
    }
  }
  for (const body of inlineScriptBodies(head, tags)) {
    if (CLIENT_HEAD_GLOBALS.some((marker) => body.includes(marker))) return true;
  }
  return false;
}

export function rewriteHeadString(head: string, managed: ManagedHead): string {
  const tags = tokenizeHead(head);
  const removals: { start: number; end: number }[] = [];
  const inject: string[] = [];
  let titleOpen: HeadTag | null = null;
  let titleClose: HeadTag | null = null;
  let headClose: HeadTag | null = null;
  let nonce: string | null = null;

  const managingTitle = managed.title !== undefined;
  const managingDescription = managed.description !== undefined;
  const managingCanonical = managed.canonical !== undefined;

  for (const tag of tags) {
    if (tag.name === 'head' && tag.isClose && headClose === null) headClose = tag;
    if (tag.name === 'title' && !tag.isClose && titleOpen === null) titleOpen = tag;
    if (tag.name === 'title' && tag.isClose && titleClose === null) titleClose = tag;
    if (tag.name === 'script' && nonce === null) {
      const tagNonce = tag.attrs.get('nonce');
      if (tagNonce) nonce = tagNonce;
    }
    if (tag.name === 'meta') {
      const metaName = tag.attrs.get('name');
      const property = tag.attrs.get('property');
      if (managingTitle && (property === 'og:title' || metaName === 'twitter:title')) removals.push(tag);
      if (managingDescription && (metaName === 'description' || property === 'og:description' || metaName === 'twitter:description')) {
        removals.push(tag);
      }
    }
    if (tag.name === 'link' && managingCanonical && tag.attrs.get('rel')?.toLowerCase() === 'canonical') {
      removals.push(tag);
    }
  }
  if (!headClose) return head; // caller treats an unclosed head as pass-through

  if (managingTitle) {
    const escaped = escapeHtml(managed.title!);
    if (titleOpen && titleClose && titleClose.start > titleOpen.end) {
      removals.push({ start: titleOpen.start, end: titleClose.end });
    }
    inject.push(`<title>${escaped}</title>`);
    inject.push(`<meta property="og:title" content="${escaped}">`);
    inject.push(`<meta name="twitter:title" content="${escaped}">`);
  }
  if (managingDescription) {
    const escaped = escapeHtml(managed.description!);
    inject.push(`<meta name="description" content="${escaped}">`);
    inject.push(`<meta property="og:description" content="${escaped}">`);
    inject.push(`<meta name="twitter:description" content="${escaped}">`);
  }
  if (managingCanonical) {
    inject.push(`<link rel="canonical" href="${escapeHtml(managed.canonical!)}">`);
  }
  if (managed.jsonLd !== undefined) {
    inject.push(`<script type="application/ld+json"${nonce ? ` nonce="${nonce}"` : ''}>${serializeJsonLd(managed.jsonLd)}</script>`);
  }

  // Apply removals (sorted, non-overlapping ranges) + the single injection
  // point just before </head>.
  const edits = [...removals].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue; // overlapping (title inside a removal) — first wins
    out += head.slice(cursor, edit.start);
    cursor = edit.end;
  }
  out += head.slice(cursor, headClose.start);
  out += inject.join('');
  out += head.slice(headClose.start);
  return out;
}

// ---------------------------------------------------------------------------
// The buffering stream transform (same contract the spike proved).
// ---------------------------------------------------------------------------

const HEAD_CLOSE_RE = /<\/head\s*>/i;

// WinterCG only: TextEncoder/TextDecoder + Uint8Array, never node:buffer. The
// fetch handler mounts this rewriter on edge runtimes (Cloudflare Workers,
// Vercel Edge) where `Buffer` is absent without nodejs_compat — a reference to
// it here would throw at module load, before any do-no-harm wrapper could
// catch it. Decoding the WHOLE accumulated buffer each time (rather than
// streaming the decoder) is what keeps a chunk boundary inside a multi-byte
// character harmless.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** Joins buffered chunks into one contiguous view. Single-chunk is the common case and copies nothing. */
function concatBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface HeadRewriteOutcome {
  readonly transformed: boolean;
  readonly refusal?: HeadRefusal;
}

export class HeadRewriter {
  private readonly managed: ManagedHead;
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private done = false;
  private outcomeState: HeadRewriteOutcome = { transformed: false };

  constructor(managed: ManagedHead) {
    this.managed = managed;
  }

  outcome(): HeadRewriteOutcome {
    return this.outcomeState;
  }

  write(chunk: Uint8Array): Uint8Array[] {
    if (this.done) return [chunk];
    // Copy: the caller may reuse or mutate its chunk once write() returns.
    this.buffered.push(new Uint8Array(chunk));
    this.bufferedBytes += chunk.byteLength;

    const soFar = concatBytes(this.buffered, this.bufferedBytes);
    const text = decoder.decode(soFar);
    const match = HEAD_CLOSE_RE.exec(text);
    if (match) {
      const closeEnd = match.index + match[0].length;
      const head = text.slice(0, closeEnd);
      this.done = true;
      this.buffered = [];
      const rest = soFar.subarray(encoder.encode(head).length);
      if (headSignalsReactHydration(head)) {
        // C-14: refuse — emit the ORIGINAL bytes untouched.
        this.outcomeState = { transformed: false, refusal: 'react_hydration_owns_head' };
        return [soFar];
      }
      let rewritten: Uint8Array;
      try {
        rewritten = encoder.encode(rewriteHeadString(head, this.managed));
      } catch {
        // An unplanned failure is just another refusal: the original bytes go
        // out untouched and the flag names it. Containing it HERE — while we
        // still hold the buffered head — is what keeps the guarantee, because
        // by the time a caller's catch runs those bytes are unrecoverable and
        // the visitor's page is already truncated.
        this.outcomeState = { transformed: false, refusal: 'rewrite_failed' };
        return [soFar];
      }
      this.outcomeState = { transformed: true };
      return rest.byteLength > 0 ? [rewritten, rest] : [rewritten];
    }

    if (this.bufferedBytes > HEAD_CAP_BYTES) {
      this.done = true;
      this.outcomeState = { transformed: false, refusal: 'head_cap_exceeded' };
      const original = this.buffered;
      this.buffered = [];
      return original;
    }
    return [];
  }

  end(): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    this.outcomeState = { transformed: false, refusal: 'no_head_found' };
    const original = this.buffered;
    this.buffered = [];
    return original;
  }
}
