/**
 * codemod/metadataLiteral.ts — the C-9 heart of `wire` (auto-head plan slice
 * A2): find `export const metadata = {...}` in a page source and decide,
 * CONSERVATIVELY, whether the object is a provable literal. Zero deps means
 * no AST library — and that is aligned with C-9 by construction: this
 * scanner's failure mode is "not provable → reported skip", never a guess.
 * Real Next.js apps supply the reason: most of their metadata is imported from
 * lib modules or computed, and a guessing codemod would corrupt it.
 *
 * PROVABLE means every value in the object (recursively) is one of: a
 * plain string ('…', "…", or a `…` template with NO ${}), a number, true/
 * false/null, an array of provable values, or a nested provable object.
 * Spreads, identifiers in value position, calls, template expressions, and
 * anything the tokenizer does not recognize DISQUALIFY the whole export.
 */

export interface FieldSpan {
  /** Dotted path, e.g. 'title' or 'openGraph.title'. */
  readonly path: string;
  /** Span of the VALUE inside the full source (start inclusive, end exclusive). */
  readonly valueStart: number;
  readonly valueEnd: number;
  /** True when the value is a plain string literal (the swappable kind). */
  readonly isString: boolean;
}

export type MetadataExtract =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly provable: false;
      readonly reason: string;
      /** Span of the whole `export const metadata … ;` statement. */
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly found: true;
      readonly provable: true;
      readonly start: number;
      readonly end: number;
      /** Span of the object literal itself. */
      readonly objStart: number;
      readonly objEnd: number;
      readonly fields: readonly FieldSpan[];
    };

const EXPORT_RE = /export\s+const\s+metadata\s*(?::\s*Metadata\s*)?=\s*/;

const isWs = (ch: string) => /\s/.test(ch);

/** Skips a string starting at `i` (quote char at source[i]); returns end index AFTER the close, or -1 on template-with-expression / unterminated. */
function skipString(source: string, i: number): number {
  const quote = source[i]!;
  let cursor = i + 1;
  while (cursor < source.length) {
    const ch = source[cursor]!;
    if (ch === '\\') { cursor += 2; continue; }
    if (quote === '`' && ch === '$' && source[cursor + 1] === '{') return -1; // template expression — not provable
    if (ch === quote) return cursor + 1;
    cursor += 1;
  }
  return -1;
}

function skipWsAndComments(source: string, i: number): number {
  let cursor = i;
  for (;;) {
    while (cursor < source.length && isWs(source[cursor]!)) cursor += 1;
    if (source.startsWith('//', cursor)) {
      const nl = source.indexOf('\n', cursor);
      cursor = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const close = source.indexOf('*/', cursor + 2);
      cursor = close === -1 ? source.length : close + 2;
      continue;
    }
    return cursor;
  }
}

interface ValueResult { end: number; isString: boolean; ok: boolean; reason?: string }

/** Parses one provable VALUE starting at `i`; collects string-field spans under `path`. */
function parseValue(source: string, i: number, path: string, fields: FieldSpan[]): ValueResult {
  const start = skipWsAndComments(source, i);
  const ch = source[start];
  if (ch === undefined) return { end: start, isString: false, ok: false, reason: 'unexpected end of source' };

  if (ch === '"' || ch === "'" || ch === '`') {
    const end = skipString(source, start);
    if (end === -1) return { end: start, isString: false, ok: false, reason: 'template expression or unterminated string' };
    fields.push({ path, valueStart: start, valueEnd: end, isString: true });
    return { end, isString: true, ok: true };
  }
  if (/[0-9-]/.test(ch)) {
    let cursor = start + 1;
    while (cursor < source.length && /[0-9.eE+_-]/.test(source[cursor]!)) cursor += 1;
    return { end: cursor, isString: false, ok: true };
  }
  for (const keyword of ['true', 'false', 'null']) {
    if (source.startsWith(keyword, start) && !/[A-Za-z0-9_$]/.test(source[start + keyword.length] ?? '')) {
      return { end: start + keyword.length, isString: false, ok: true };
    }
  }
  if (ch === '[') {
    let cursor = start + 1;
    for (;;) {
      cursor = skipWsAndComments(source, cursor);
      if (source[cursor] === ']') return { end: cursor + 1, isString: false, ok: true };
      const value = parseValue(source, cursor, `${path}[]`, []);
      if (!value.ok) return value;
      cursor = skipWsAndComments(source, value.end);
      if (source[cursor] === ',') { cursor += 1; continue; }
      if (source[cursor] === ']') return { end: cursor + 1, isString: false, ok: true };
      return { end: cursor, isString: false, ok: false, reason: 'unrecognized array syntax' };
    }
  }
  if (ch === '{') {
    const object = parseObject(source, start, path === '' ? '' : `${path}.`, fields);
    return { end: object.ok ? object.end : start, isString: false, ok: object.ok, ...(object.ok ? {} : { reason: object.reason }) };
  }
  return { end: start, isString: false, ok: false, reason: `unprovable value (identifier/call/spread) near "${source.slice(start, start + 24)}"` };
}

interface ObjectResult { end: number; ok: boolean; reason?: string }

function parseObject(source: string, i: number, pathPrefix: string, fields: FieldSpan[]): ObjectResult {
  let cursor = i + 1; // past '{'
  for (;;) {
    cursor = skipWsAndComments(source, cursor);
    if (source[cursor] === '}') return { end: cursor + 1, ok: true };
    if (source.startsWith('...', cursor)) return { end: cursor, ok: false, reason: 'spread' };

    // Key: identifier or string.
    let key = '';
    if (source[cursor] === '"' || source[cursor] === "'") {
      const end = skipString(source, cursor);
      if (end === -1) return { end: cursor, ok: false, reason: 'unterminated key string' };
      key = source.slice(cursor + 1, end - 1);
      cursor = end;
    } else {
      while (cursor < source.length && /[A-Za-z0-9_$]/.test(source[cursor]!)) { key += source[cursor]!; cursor += 1; }
      if (key === '') return { end: cursor, ok: false, reason: `unrecognized object syntax near "${source.slice(cursor, cursor + 24)}"` };
    }
    cursor = skipWsAndComments(source, cursor);
    if (source[cursor] !== ':') return { end: cursor, ok: false, reason: `shorthand/method property "${key}"` };
    const value = parseValue(source, cursor + 1, `${pathPrefix}${key}`, fields);
    if (!value.ok) return { end: value.end, ok: false, reason: value.reason ?? 'unprovable value' };
    cursor = skipWsAndComments(source, value.end);
    if (source[cursor] === ',') { cursor += 1; continue; }
    if (source[cursor] === '}') return { end: cursor + 1, ok: true };
    return { end: cursor, ok: false, reason: 'unrecognized separator' };
  }
}

export function extractMetadataExport(source: string): MetadataExtract {
  const match = EXPORT_RE.exec(source);
  if (!match) return { found: false };
  const start = match.index;
  const objStart = skipWsAndComments(source, match.index + match[0].length);
  if (source[objStart] !== '{') {
    return { found: true, provable: false, reason: 'metadata is not an object literal (imported/computed value)', start, end: objStart };
  }
  const fields: FieldSpan[] = [];
  const object = parseObject(source, objStart, '', fields);
  let end = object.end;
  const afterObj = skipWsAndComments(source, end);
  if (source[afterObj] === ';') end = afterObj + 1;
  if (!object.ok) {
    return { found: true, provable: false, reason: object.reason ?? 'unprovable literal', start, end };
  }
  return { found: true, provable: true, start, end, objStart, objEnd: object.ok ? object.end : objStart, fields };
}
