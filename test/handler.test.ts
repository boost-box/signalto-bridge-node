/**
 * handler.test.ts — the canonical node handler through REAL Express + HTTP:
 * interception (robots/root files/redirects/headers), pass-through fidelity,
 * probe echo, the control surface, and the do-no-harm contract under
 * hostile conditions (no state, engine down, engine slow, unconfigured).
 */
import { createHmac } from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { signaltoBridge } from '../src/adapters/express.js';
import { CONNECTOR_VERSION } from '../src/index.js';
import { TEST_SITE_KEY, TEST_ENGINE_URL, listen, stubEngine, waitForStateVersion, type RunningApp } from './helpers.js';

const STATE = {
  robots: 'User-agent: GPTBot\nAllow: /\n',
  rootFiles: { 'llms.txt': '# SignalTo llms.txt' },
  redirects: [{ from: '/old-page', to: '/new-page', statusCode: 301 }],
  headerRules: { '/tagged': { 'X-Robots-Tag': 'noindex', 'X-App-Header': null } },
};

let running: RunningApp | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

/** Boots a real Express app with the bridge mounted FIRST and an app-owned surface behind it. */
async function bootApp(overrides: Parameters<typeof signaltoBridge>[0] = {}) {
  const engine = stubEngine(1, STATE);
  const middleware = signaltoBridge({
    engineUrl: TEST_ENGINE_URL,
    siteKey: TEST_SITE_KEY,
    fetchFn: engine.fetchFn,
    cacheTtlMs: 60_000,
    ...overrides,
  });
  const app = express();
  app.use(middleware);
  app.get('/robots.txt', (_req, res) => { res.type('text/plain').send('app-owned robots'); });
  app.get('/tagged', (_req, res) => {
    res.setHeader('X-App-Header', 'app-value');
    res.send('tagged page');
  });
  app.get('/plain', (_req, res) => { res.send('plain page'); });
  running = await listen(app);
  return { engine, middleware, baseUrl: running.baseUrl };
}

describe('interception (the middleware four)', () => {
  it('serves managed robots.txt, winning over the app-owned handler (L-N7)', async () => {
    const { middleware, baseUrl } = await bootApp();
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    const res = await fetch(`${baseUrl}/robots.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(STATE.robots);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('serves managed root files and 301s managed redirects before app routing', async () => {
    const { middleware, baseUrl } = await bootApp();
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    const llms = await fetch(`${baseUrl}/llms.txt`);
    expect(llms.status).toBe(200);
    expect(await llms.text()).toBe('# SignalTo llms.txt');

    const redirect = await fetch(`${baseUrl}/old-page`, { redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/new-page');
  });

  it('sets and REMOVES headers on a rule-matched app page (writeHead patch)', async () => {
    const { middleware, baseUrl } = await bootApp();
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    const res = await fetch(`${baseUrl}/tagged`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('tagged page');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('x-app-header')).toBe(null); // app set it; the rule removed it
  });

  it('HEAD on a managed file returns headers only', async () => {
    const { middleware, baseUrl } = await bootApp();
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    const res = await fetch(`${baseUrl}/robots.txt`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('pass-through fidelity (do-no-harm, §5.7)', () => {
  it('unmanaged paths reach the app byte-identically', async () => {
    const { middleware, baseUrl } = await bootApp();
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    const res = await fetch(`${baseUrl}/plain`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('plain page');
  });

  it('cold start with no cache passes through — the app-owned robots serves', async () => {
    const engine = stubEngine(1, STATE);
    engine.setFailure('network'); // engine down from the very first pull
    const middleware = signaltoBridge({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    const app = express();
    app.use(middleware);
    app.get('/robots.txt', (_req, res) => { res.type('text/plain').send('app-owned robots'); });
    running = await listen(app);
    const res = await fetch(`${running.baseUrl}/robots.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('app-owned robots');
  });

  it('a SLOW engine never appears in request latency (zero awaits on the hot path)', async () => {
    const engine = stubEngine(1, STATE);
    engine.setDelayMs(2_000);
    const middleware = signaltoBridge({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, cacheTtlMs: 1 });
    const app = express();
    app.use(middleware);
    app.get('/plain', (_req, res) => { res.send('plain page'); });
    running = await listen(app);
    const before = Date.now();
    const res = await fetch(`${running.baseUrl}/plain`);
    expect(await res.text()).toBe('plain page');
    expect(Date.now() - before).toBeLessThan(500); // the 2s engine stall is invisible
  });

  it('an unconfigured bridge is inert — pure pass-through, never a boot crash', async () => {
    const middleware = signaltoBridge({ siteKey: undefined, engineUrl: undefined });
    expect(middleware.bridge.health()).toEqual({ configured: false, flag: 'missing_site_key' });
    const app = express();
    app.use(middleware);
    app.get('/robots.txt', (_req, res) => { res.type('text/plain').send('app-owned robots'); });
    running = await listen(app);
    const res = await fetch(`${running.baseUrl}/robots.txt`);
    expect(await res.text()).toBe('app-owned robots');
  });
});

describe('end-to-end probe echo (capability truth, L-N6/L-N14)', () => {
  const echoFor = (nonce: string) => createHmac('sha256', TEST_SITE_KEY).update(`probe.${nonce}`).digest('hex');

  it('echoes the signed probe header on managed, pass-through, and redirect paths', async () => {
    const { middleware, baseUrl } = await bootApp();
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);

    const managed = await fetch(`${baseUrl}/robots.txt?__signalto_probe=aa11`);
    expect(managed.headers.get('x-signalto-probe')).toBe(echoFor('aa11'));

    const pass = await fetch(`${baseUrl}/plain?__signalto_probe=bb22`);
    expect(pass.headers.get('x-signalto-probe')).toBe(echoFor('bb22'));
    expect(await pass.text()).toBe('plain page'); // echo never changes the response body

    const redirected = await fetch(`${baseUrl}/old-page?__signalto_probe=cc33`, { redirect: 'manual' });
    expect(redirected.status).toBe(301);
    expect(redirected.headers.get('x-signalto-probe')).toBe(echoFor('cc33'));
  });

  it('ignores malformed probe nonces (no echo, no error)', async () => {
    const { baseUrl } = await bootApp();
    const res = await fetch(`${baseUrl}/plain?__signalto_probe=NOT-HEX!`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-signalto-probe')).toBe(null);
  });
});

describe('control surface', () => {
  const signedHeaders = (action: string) => {
    const timestamp = Date.now();
    const nonce = `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const signature = createHmac('sha256', TEST_SITE_KEY).update(`${action}.${timestamp}.${nonce}`).digest('hex');
    return {
      'x-signalto-timestamp': String(timestamp),
      'x-signalto-nonce': nonce,
      'x-signalto-signature': signature,
    };
  };

  it('answers /ping with the signed challenge echo + version', async () => {
    const { baseUrl } = await bootApp();
    const res = await fetch(`${baseUrl}/__signalto/ping?challenge=deadbeef`);
    expect(res.status).toBe(200);
    const body = await res.json() as { signature: string; version: string };
    expect(body.version).toBe(CONNECTOR_VERSION);
    expect(body.signature).toBe(createHmac('sha256', TEST_SITE_KEY).update('ping.deadbeef').digest('hex'));
  });

  it('answers signed /capabilities and refuses a bad signature with 401', async () => {
    const { middleware, baseUrl } = await bootApp();
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    const ok = await fetch(`${baseUrl}/__signalto/capabilities`, { headers: signedHeaders('capabilities') });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { version: string; state_version: number; wired_slots: unknown[] };
    expect(body.version).toBe(CONNECTOR_VERSION);
    expect(body.state_version).toBe(1);
    expect(body.wired_slots).toEqual([]);

    const forged = { ...signedHeaders('capabilities'), 'x-signalto-signature': '0'.repeat(64) };
    const bad = await fetch(`${baseUrl}/__signalto/capabilities`, { headers: forged });
    expect(bad.status).toBe(401);
  });

  it('refuses a REPLAYED nonce', async () => {
    const { baseUrl } = await bootApp();
    const headers = signedHeaders('capabilities');
    const first = await fetch(`${baseUrl}/__signalto/capabilities`, { headers });
    expect(first.status).toBe(200);
    const replay = await fetch(`${baseUrl}/__signalto/capabilities`, { headers });
    expect(replay.status).toBe(401);
    expect((await replay.json() as { error: { code: string } }).error.code).toBe('nonce_replayed');
  });

  it('POST /refresh re-pulls immediately so a post-apply verify sees fresh state', async () => {
    const { engine, middleware, baseUrl } = await bootApp();
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    engine.setState(2, { ...STATE, robots: 'User-agent: *\nDisallow: /private\n' });
    const res = await fetch(`${baseUrl}/__signalto/refresh`, { method: 'POST', headers: signedHeaders('refresh') });
    expect(res.status).toBe(200);
    expect((await res.json() as { state_version: number }).state_version).toBe(2);
    const robots = await fetch(`${baseUrl}/robots.txt`);
    expect(await robots.text()).toContain('Disallow: /private');
  });
});
