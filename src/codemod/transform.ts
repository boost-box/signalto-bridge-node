/**
 * codemod/transform.ts — turns a provable `export const metadata = {…}` into
 * the slot-wired `generateMetadata` (auto-head plan slice A2). Span-splicing
 * on the ORIGINAL literal text preserves the developer's formatting and every
 * field the codemod does not manage; the extracted literal becomes the wired
 * FALLBACK (and therefore the rollback target).
 *
 * C-2 coherence carries into the wiring: when title/description are managed,
 * their openGraph/twitter counterparts (when present as string literals) are
 * re-pointed at the SAME managed values, so a managed title never leaves
 * stale share cards behind.
 */
import { extractMetadataExport, type FieldSpan } from './metadataLiteral.js';

export type TransformResult =
  | { readonly changed: true; readonly output: string; readonly managedFields: readonly string[] }
  | { readonly changed: false; readonly skipReason: string };

const findSpan = (fields: readonly FieldSpan[], path: string): FieldSpan | undefined =>
  fields.find((field) => field.path === path && field.isString);

export function transformPageSource(source: string, slotName: string, bridgeImportPath: string): TransformResult {
  // Idempotency (C-9): a file that already wires SignalTo — or already has a
  // generateMetadata of its own — is never touched again.
  if (source.includes('signaltoMeta') || source.includes('generateMetadata')) {
    return { changed: false, skipReason: 'already wired (signaltoMeta/generateMetadata present)' };
  }

  const extract = extractMetadataExport(source);
  if (!extract.found) return { changed: false, skipReason: 'no `export const metadata` found' };
  if (!extract.provable) return { changed: false, skipReason: `metadata is not a provable literal: ${extract.reason}` };

  const title = findSpan(extract.fields, 'title');
  const description = findSpan(extract.fields, 'description');
  if (!title && !description) {
    return { changed: false, skipReason: 'literal has no top-level string title/description to manage' };
  }

  // The fallback = the page's own current values, verbatim spans.
  const fallbackFields: string[] = [];
  const managedFields: string[] = [];
  if (title) { fallbackFields.push(`title: ${source.slice(title.valueStart, title.valueEnd)}`); managedFields.push('title'); }
  if (description) { fallbackFields.push(`description: ${source.slice(description.valueStart, description.valueEnd)}`); managedFields.push('description'); }

  // Splice managed references into the ORIGINAL literal: the managed field
  // itself, plus its og/twitter counterparts (C-2 group coherence).
  const splices: { start: number; end: number; text: string }[] = [];
  const pushSplice = (span: FieldSpan | undefined, text: string) => {
    if (span) splices.push({ start: span.valueStart, end: span.valueEnd, text });
  };
  if (title) {
    pushSplice(title, 'managed.title');
    pushSplice(findSpan(extract.fields, 'openGraph.title'), 'managed.title');
    pushSplice(findSpan(extract.fields, 'twitter.title'), 'managed.title');
  }
  if (description) {
    pushSplice(description, 'managed.description');
    pushSplice(findSpan(extract.fields, 'openGraph.description'), 'managed.description');
    pushSplice(findSpan(extract.fields, 'twitter.description'), 'managed.description');
  }
  splices.sort((a, b) => a.start - b.start);
  let spliced = '';
  let cursor = extract.objStart;
  for (const splice of splices) {
    spliced += source.slice(cursor, splice.start) + splice.text;
    cursor = splice.end;
  }
  spliced += source.slice(cursor, extract.objEnd);

  const hadTypeAnnotation = /export\s+const\s+metadata\s*:\s*Metadata/.test(source.slice(extract.start, extract.objStart));
  const replacement = `/* SignalTo meta slot (wired by \`signalto-bridge wire\`): the managed
   title/description win when published; the literal below stays the wired
   fallback and the rollback target. Share-card fields follow the managed
   values so they never go stale. */
const SIGNALTO_META_FALLBACK = { ${fallbackFields.join(', ')} };

export async function generateMetadata()${hadTypeAnnotation ? ': Promise<Metadata>' : ''} {
  const managed = await signaltoMeta(bridge, ${JSON.stringify(slotName)}, SIGNALTO_META_FALLBACK);
  return ${spliced};
}`;

  let output = source.slice(0, extract.start) + replacement + source.slice(extract.end);

  // Imports: appended after the last existing top-of-file import.
  const importLines: string[] = [];
  if (!output.includes('@signalto/bridge-node/next')) {
    importLines.push(`import { signaltoMeta } from "@signalto/bridge-node/next";`);
  }
  if (!new RegExp(`from ["']${bridgeImportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(output)) {
    importLines.push(`import { bridge } from ${JSON.stringify(bridgeImportPath)};`);
  }
  if (importLines.length > 0) {
    output = output.slice(0, endOfImportBlock(output)) + importLines.join('\n') + '\n' + output.slice(endOfImportBlock(output));
  }

  return { changed: true, output, managedFields };
}

/**
 * The insertion point AFTER the last complete import STATEMENT — statement-
 * aware, not line-based (real-world pages have multi-line imports; a
 * line-regex spliced new imports into the MIDDLE of one — caught by the A2
 * typecheck acceptance against a real Next.js app). Each import is scanned to its
 * module-specifier string, then to end-of-line.
 */
function endOfImportBlock(source: string): number {
  let end = 0;
  const importStart = /^import\b/gm;
  for (let match = importStart.exec(source); match; match = importStart.exec(source)) {
    let cursor = match.index;
    // Scan to the module specifier's opening quote (skipping everything the
    // clause contains — including newlines in a multi-line named import).
    while (cursor < source.length && source[cursor] !== '"' && source[cursor] !== "'") cursor += 1;
    if (cursor >= source.length) break;
    const quote = source[cursor]!;
    const closeQuote = source.indexOf(quote, cursor + 1);
    if (closeQuote === -1) break;
    const newline = source.indexOf('\n', closeQuote);
    const statementEnd = newline === -1 ? source.length : newline + 1;
    if (statementEnd > end) end = statementEnd;
    importStart.lastIndex = statementEnd;
  }
  return end;
}
