/**
 * codemod.test.ts — slice A2's `wire` codemod: the C-9 provable-literal
 * contract (transform only what can be proven; report everything else),
 * span-splicing fidelity, C-2 share-card coherence, idempotency, and route
 * derivation. Fixtures mirror REAL Next.js app patterns — including the
 * imported/computed metadata cases that MUST skip.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractMetadataExport } from '../src/codemod/metadataLiteral.js';
import { transformPageSource } from '../src/codemod/transform.js';
import { routeForPageFile, slotNameForRoute, wire } from '../src/codemod/wire.js';

const LITERAL_PAGE = `import type { Metadata } from "next";
import Hero from "@/components/Hero";

export const metadata: Metadata = {
  title: "Pricing",
  description: "What it costs, and why.",
  alternates: { canonical: "/pricing" },
  openGraph: { title: "Pricing | IGAIV", description: "What it costs, and why.", url: "/pricing", type: "website" },
  twitter: { title: "Pricing | IGAIV" },
};

export default function Pricing() {
  return <Hero />;
}
`;

describe('extractMetadataExport (the C-9 prover)', () => {
  it('proves a pure literal and records the swappable string spans', () => {
    const extract = extractMetadataExport(LITERAL_PAGE);
    expect(extract.found && extract.provable).toBe(true);
    if (extract.found && extract.provable) {
      const paths = extract.fields.map((field) => field.path);
      expect(paths).toContain('title');
      expect(paths).toContain('openGraph.title');
      expect(paths).toContain('alternates.canonical');
    }
  });

  it('DISQUALIFIES identifiers, spreads, calls, and template expressions — the real-app reality', () => {
    const cases: [string, RegExp][] = [
      ['export const metadata: Metadata = { title: SITE.name };', /unprovable value/],
      ['export const metadata = { ...BASE_META, title: "x" };', /spread/],
      ['export const metadata = { title: buildTitle("x") };', /unprovable value/],
      ['export const metadata = { title: `Hi ${name}` };', /template expression/],
      ['export const metadata = pageMeta("/about");', /not an object literal/],
    ];
    for (const [source, reason] of cases) {
      const extract = extractMetadataExport(source);
      expect(extract.found).toBe(true);
      if (extract.found && !extract.provable) expect(extract.reason).toMatch(reason);
      else throw new Error(`should not be provable: ${source}`);
    }
  });
});

describe('transformPageSource', () => {
  it('wires the literal: fallback preserved verbatim, managed refs spliced, C-2 share cards follow', () => {
    const result = transformPageSource(LITERAL_PAGE, 'pricing', '@/lib/signalto');
    expect(result.changed).toBe(true);
    if (!result.changed) return;
    const out = result.output;
    expect(out).toContain('const SIGNALTO_META_FALLBACK = { title: "Pricing", description: "What it costs, and why." };');
    expect(out).toContain('export async function generateMetadata(): Promise<Metadata> {');
    expect(out).toContain('await signaltoMeta(bridge, "pricing", SIGNALTO_META_FALLBACK)');
    // Splices: managed refs replace the literals; og/twitter follow (C-2).
    expect(out).toContain('title: managed.title');
    expect(out).toContain('openGraph: { title: managed.title, description: managed.description,');
    expect(out).toContain('twitter: { title: managed.title }');
    // Unmanaged fields survive verbatim.
    expect(out).toContain('alternates: { canonical: "/pricing" }');
    expect(out).toContain('url: "/pricing", type: "website"');
    // Imports appended after the existing import block.
    expect(out).toContain('import { signaltoMeta } from "@signalto/bridge-node/next";');
    expect(out).toContain('import { bridge } from "@/lib/signalto";');
    expect(out.indexOf('import { bridge }')).toBeGreaterThan(out.indexOf('import Hero'));
    // The component below is untouched.
    expect(out).toContain('export default function Pricing()');
  });

  it('is idempotent: its own output (or any hand-wired page) is skipped', () => {
    const first = transformPageSource(LITERAL_PAGE, 'pricing', '@/lib/signalto');
    if (!first.changed) throw new Error('first pass should transform');
    const second = transformPageSource(first.output, 'pricing', '@/lib/signalto');
    expect(second).toMatchObject({ changed: false, skipReason: expect.stringContaining('already wired') });
  });

  it('inserts imports AFTER a multi-line import statement — the real-app bug the typecheck acceptance caught', () => {
    const multiLineImportPage = `import type { Metadata } from "next";
import {
  OPERATOR_FAQS, OPERATOR_MENTIONS,
} from "@/lib/audiences";

export const metadata: Metadata = { title: "Ops", description: "d" };

export default function Ops() { return null; }
`;
    const result = transformPageSource(multiLineImportPage, 'operators', '@/lib/signalto');
    expect(result.changed).toBe(true);
    if (!result.changed) return;
    const importIdx = result.output.indexOf('import { bridge }');
    const audiencesEnd = result.output.indexOf('} from "@/lib/audiences";');
    expect(importIdx).toBeGreaterThan(audiencesEnd); // never spliced INTO the multi-line import
    expect(result.output.indexOf('export const') === -1 || importIdx < result.output.indexOf('const SIGNALTO_META_FALLBACK')).toBe(true);
  });

  it('skips literals with nothing manageable, reporting the reason', () => {
    const result = transformPageSource('export const metadata = { robots: { index: false } };', 'x', '@/lib/signalto');
    expect(result).toMatchObject({ changed: false, skipReason: expect.stringContaining('no top-level string title/description') });
  });
});

describe('route derivation', () => {
  it('strips route groups, refuses dynamic segments, names slots from routes', () => {
    expect(routeForPageFile('/app', '/app/how-it-works/page.tsx')).toBe('/how-it-works');
    expect(routeForPageFile('/app', '/app/(marketing)/pricing/page.tsx')).toBe('/pricing');
    expect(routeForPageFile('/app', '/app/page.tsx')).toBe('/');
    expect(routeForPageFile('/app', '/app/blog/[slug]/page.tsx')).toBe(null);
    expect(slotNameForRoute('/')).toBe('home');
    expect(slotNameForRoute('/insights/foo')).toBe('insights-foo');
  });
});

describe('wire() end-to-end on a scratch app dir', () => {
  it('transforms provables, skips the rest with reasons, emits the manifest snippet; dry-run writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'signalto-wire-'));
    mkdirSync(join(dir, 'pricing'), { recursive: true });
    mkdirSync(join(dir, 'about'), { recursive: true });
    mkdirSync(join(dir, 'blog', '[slug]'), { recursive: true });
    writeFileSync(join(dir, 'pricing', 'page.tsx'), LITERAL_PAGE);
    writeFileSync(join(dir, 'about', 'page.tsx'), 'import { PAGES } from "@/lib/pages";\nexport const metadata = PAGES.about;\nexport default function About() { return null; }\n');
    writeFileSync(join(dir, 'blog', '[slug]', 'page.tsx'), 'export const metadata = { title: "post" };\nexport default function Post() { return null; }\n');

    const dry = wire({ appDir: dir, dryRun: true });
    expect(dry.outcomes.filter((outcome) => outcome.action === 'transformed')).toHaveLength(1);
    expect(readFileSync(join(dir, 'pricing', 'page.tsx'), 'utf8')).toBe(LITERAL_PAGE); // dry-run wrote nothing
    const skipReasons = dry.outcomes.filter((outcome) => outcome.action === 'skipped').map((outcome) => outcome.reason!);
    expect(skipReasons.some((reason) => reason.includes('not a provable literal'))).toBe(true);
    expect(skipReasons.some((reason) => reason.includes('dynamic route'))).toBe(true);
    expect(dry.manifestSnippet).toContain('{ opType: "meta", name: "pricing", path: "/pricing", mode: "static" },');

    const real = wire({ appDir: dir });
    expect(real.outcomes.filter((outcome) => outcome.action === 'transformed')).toHaveLength(1);
    const wired = readFileSync(join(dir, 'pricing', 'page.tsx'), 'utf8');
    expect(wired).toContain('signaltoMeta(bridge, "pricing"');

    // Second run: fully idempotent.
    const again = wire({ appDir: dir });
    expect(again.outcomes.every((outcome) => outcome.action === 'skipped')).toBe(true);
  });
});
