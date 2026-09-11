/**
 * codemod/wire.ts — the `wire` command's orchestration (auto-head plan slice
 * A2): scan a Next App Router project for `app/**\/page.{tsx,ts,jsx,js}`,
 * transform the provable-literal metadata exports, and produce the report —
 * transforms performed, skips WITH REASONS (C-9: every non-literal is a
 * reported skip carrying the manual recipe), and the slots-manifest snippet
 * to paste into the bridge config. The diff is left uncommitted for the
 * developer to review — the bridge still never writes to a repo on its own;
 * the DEVELOPER runs this, locally, on purpose.
 *
 * Node-only module (fs) — the CLI entry, never bundled into runtime handlers.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { transformPageSource } from './transform.js';

export interface WireOutcome {
  readonly file: string;
  readonly route: string | null;
  readonly action: 'transformed' | 'skipped';
  readonly slotName?: string;
  readonly reason?: string;
}

export interface WireReport {
  readonly outcomes: readonly WireOutcome[];
  readonly manifestSnippet: string;
}

const PAGE_FILE_RE = /^page\.(tsx|ts|jsx|js)$/;

/** Route derivation from an app-dir page path: route groups `(x)` vanish, dynamic `[param]` segments make the route null (unwireable by ONE slot — reported, C-9). */
export function routeForPageFile(appDir: string, filePath: string): string | null {
  const segments = relative(appDir, filePath).split(sep).slice(0, -1);
  const parts: string[] = [];
  for (const segment of segments) {
    if (/^\(.*\)$/.test(segment)) continue; // route group
    if (/^@/.test(segment)) continue; // parallel route slot
    if (/\[.*\]/.test(segment)) return null; // dynamic — one slot cannot represent it
    parts.push(segment);
  }
  return `/${parts.join('/')}`.replace(/\/$/, '') || '/';
}

export function slotNameForRoute(route: string): string {
  return route === '/' ? 'home' : route.slice(1).replace(/\//g, '-');
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

export interface WireOptions {
  /** The Next `app` directory. */
  readonly appDir: string;
  /** Import path pages use for the shared bridge instance. Default '@/lib/signalto'. */
  readonly bridgeImportPath?: string;
  /** Report only — write nothing. */
  readonly dryRun?: boolean;
}

export function wire(options: WireOptions): WireReport {
  const bridgeImportPath = options.bridgeImportPath ?? '@/lib/signalto';
  const outcomes: WireOutcome[] = [];
  const wiredSlots: { name: string; path: string }[] = [];

  for (const file of walk(options.appDir)) {
    const base = file.split(sep).pop()!;
    if (!PAGE_FILE_RE.test(base)) continue;
    const route = routeForPageFile(options.appDir, file);
    if (route === null) {
      outcomes.push({ file, route, action: 'skipped', reason: 'dynamic route — one slot cannot represent per-param metadata; wire signaltoMeta by hand inside generateMetadata if wanted' });
      continue;
    }
    const source = readFileSync(file, 'utf8');
    const slotName = slotNameForRoute(route);
    const result = transformPageSource(source, slotName, bridgeImportPath);
    if (!result.changed) {
      outcomes.push({ file, route, action: 'skipped', reason: result.skipReason });
      continue;
    }
    if (!options.dryRun) writeFileSync(file, result.output, 'utf8');
    outcomes.push({ file, route, action: 'transformed', slotName });
    wiredSlots.push({ name: slotName, path: route });
  }

  const manifestSnippet = wiredSlots.length === 0
    ? ''
    : `// Add to createBridge({ slots: [...] }) in your signalto bridge module:\n`
      + wiredSlots.map((slot) => `  { opType: "meta", name: ${JSON.stringify(slot.name)}, path: ${JSON.stringify(slot.path)}, mode: "static" },`).join('\n')
      + `\n// (set mode to "dynamic"/"isr" where the route renders that way; static\n// routes need the revalidatePath hook wired in the control route handler)`;

  return { outcomes, manifestSnippet };
}
