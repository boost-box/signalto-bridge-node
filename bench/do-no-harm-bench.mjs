/**
 * do-no-harm-bench.mjs — the §5.7 hot-path budget, measured (zero-dep):
 * baseline plain-http server vs the same server with the bridge mounted
 * (state pulled, nothing managed on the benched path — the overwhelmingly
 * common case). Reports per-request latency percentiles and the delta.
 *
 * Run: npm run bench   (from bridge/node; requires `npm run build` first is
 * NOT needed — imports src via tsx if available, falls back to dist)
 *
 * Budget (plan §5.7): < 10µs added per unmanaged request, < 1% p99 overhead.
 * This harness is evidence, not a CI gate — laptop numbers vary; the shape
 * to look for is a sub-microsecond-to-low-microsecond mean delta.
 */
import { createServer } from 'node:http';

const { createBridge } = await import('../dist/index.js');
const { createNodeHandler } = await import('../dist/handlers/node.js');

const REQUESTS = 20_000;
const CONCURRENCY = 32;
const WARMUP = 2_000;

function appHandler(_req, res) {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('plain page');
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function bench(url) {
  const latencies = new Float64Array(REQUESTS);
  let issued = 0;
  let recorded = 0;
  async function worker() {
    for (;;) {
      const i = issued;
      if (i >= REQUESTS + WARMUP) return;
      issued += 1;
      const start = process.hrtime.bigint();
      const res = await fetch(`${url}/plain`);
      await res.arrayBuffer();
      const ns = Number(process.hrtime.bigint() - start);
      if (i >= WARMUP && recorded < REQUESTS) {
        latencies[recorded] = ns / 1e3; // µs
        recorded += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const sorted = latencies.slice(0, recorded).sort();
  const pick = (q) => sorted[Math.min(recorded - 1, Math.floor(recorded * q))];
  const mean = sorted.reduce((a, b) => a + b, 0) / recorded;
  return { mean, p50: pick(0.5), p99: pick(0.99) };
}

// Stub engine so the bridge holds a real (unrelated-path) managed state.
const engineFetch = async () => new Response(JSON.stringify({
  version: 1, schema_version: 1,
  state: { robots: 'User-agent: *\n', redirects: [{ from: '/elsewhere', to: '/x' }] },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const baseline = createServer(appHandler);
const baselineUrl = await listen(baseline);

const bridge = createBridge({ engineUrl: 'https://e', siteKey: `sk_1_${'ab'.repeat(24)}`, fetchFn: engineFetch });
await bridge.state.refreshNow();
const handler = createNodeHandler(bridge);
const mounted = createServer((req, res) => handler(req, res, () => appHandler(req, res)));
const mountedUrl = await listen(mounted);

console.log(`baseline warm-up + ${REQUESTS} requests x${CONCURRENCY}...`);
const a1 = await bench(baselineUrl);
console.log(`mounted  warm-up + ${REQUESTS} requests x${CONCURRENCY}...`);
const b1 = await bench(mountedUrl);
// Second interleaved round to damp machine drift.
const a2 = await bench(baselineUrl);
const b2 = await bench(mountedUrl);

const base = { mean: (a1.mean + a2.mean) / 2, p50: (a1.p50 + a2.p50) / 2, p99: (a1.p99 + a2.p99) / 2 };
const withBridge = { mean: (b1.mean + b2.mean) / 2, p50: (b1.p50 + b2.p50) / 2, p99: (b1.p99 + b2.p99) / 2 };

const fmt = (v) => v.toFixed(1).padStart(8);
console.log('\n            mean(µs)   p50(µs)   p99(µs)');
console.log(`baseline  ${fmt(base.mean)} ${fmt(base.p50)} ${fmt(base.p99)}`);
console.log(`mounted   ${fmt(withBridge.mean)} ${fmt(withBridge.p50)} ${fmt(withBridge.p99)}`);
console.log(`delta     ${fmt(withBridge.mean - base.mean)} ${fmt(withBridge.p50 - base.p50)} ${fmt(withBridge.p99 - base.p99)}`);
console.log(`p99 overhead: ${(((withBridge.p99 - base.p99) / base.p99) * 100).toFixed(2)}%  (budget: <1%; negative = noise floor)`);

baseline.close();
mounted.close();
