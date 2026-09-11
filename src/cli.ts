#!/usr/bin/env node
/**
 * cli.ts — `signalto-bridge` (auto-head plan slice A2). One command today:
 *
 *   signalto-bridge wire [--dir <appDir>] [--bridge-import <path>] [--dry-run]
 *
 * Wires provable-literal `export const metadata` pages to signaltoMeta slots
 * and prints the report: transforms, skips WITH reasons (C-9), and the
 * slots-manifest snippet. Writes reviewable diffs only — commit nothing.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { wire } from './codemod/wire.js';

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : undefined;
}

if (command !== 'wire') {
  console.log('usage: signalto-bridge wire [--dir <appDir>] [--bridge-import <path>] [--dry-run]');
  process.exit(command === undefined || command === '--help' ? 0 : 1);
}

const dirOption = flag('--dir');
const appDir = dirOption ?? ['app', 'src/app', 'site/app'].map((candidate) => join(process.cwd(), candidate)).find(existsSync);
if (!appDir || !existsSync(appDir)) {
  console.error('no Next `app` directory found — pass --dir <path-to-app-dir>');
  process.exit(1);
}

const dryRun = args.includes('--dry-run');
const report = wire({ appDir, dryRun, ...(flag('--bridge-import') ? { bridgeImportPath: flag('--bridge-import')! } : {}) });

let transformed = 0;
for (const outcome of report.outcomes) {
  if (outcome.action === 'transformed') {
    transformed += 1;
    console.log(`WIRED   ${outcome.file}  →  slot meta/${outcome.slotName} (${outcome.route})${dryRun ? '  [dry-run: not written]' : ''}`);
  } else {
    console.log(`SKIP    ${outcome.file}  —  ${outcome.reason}`);
  }
}
console.log(`\n${transformed} page(s) ${dryRun ? 'would be ' : ''}wired, ${report.outcomes.length - transformed} skipped (each skip names its reason — non-literal metadata stays yours to wire by hand).`);
if (report.manifestSnippet) {
  console.log('\n' + report.manifestSnippet);
}
