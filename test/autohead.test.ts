/**
 * autohead.test.ts — slice A1's connector side over REAL HTTP: the transform
 * mode in the node handler (Express) and the fetch handler, asserting the
 * C-rules the S-6 spike proved, now as production behavior: C-1 combined
 * ETag, C-2 group replacement, C-4 gate, C-10 compression disengage, C-14
 * head-signal refusal, C-6-by-inheritance (rewriter), and probe/HEAD edges.
 */
import compression from 'compression';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { signaltoBridge } from '../src/adapters/express.js';
import { createFetchHandler } from '../src/handlers/fetch.js';
import { combinedHeadEtag, createBridge } from '../src/index.js';
import { TEST_SITE_KEY, TEST_ENGINE_URL, stubEngine, waitForStateVersion, type RunningApp, listen } from './helpers.js';

const PAGE_HTML = `<!DOCTYPE html><html><head>
<title>App Title</title>
<meta name="description" content="app description">
<meta property="og:title" content="App Title">
<link rel="canonical" href="/app-canonical">
</head><body>page body ${'x'.repeat(1500)}</body></html>`;

const REACT_PAGE_HTML = `<!DOCTYPE html><html><head>
<title>React App</title>
<script src="/_next/static/chunks/main.js"></script>
</head><body><div id="root">hydrated</div></body></html>`;

const STATE = {
  heads: {
    '/managed': { title: 'Managed Title', description: 'Managed description', canonical: 'https://site.test/managed', jsonLd: { '@type': 'Organization', name: 'S-A1' } },
    '/react-page': { title: 'Should Not Appear' },
    '/json-api': { title: 'Should Not Appear Either' },
  },
};

let running: RunningApp | null = null;
afterEach(async () => { await running?.close(); running = null; });

async function bootExpress() {
  const engine = stubEngine(1, STATE);
  const middleware = signaltoBridge({
    engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, autoHead: true,
  });
  const app = express();
  app.use(middleware);
  app.use(compression({ threshold: 0 }));
  app.set('etag', 'strong');
  app.get('/managed', (_req, res) => { res.type('html').send(PAGE_HTML); });
  app.get('/react-page', (_req, res) => { res.type('html').send(REACT_PAGE_HTML); });
  app.get('/json-api', (_req, res) => { res.json({ plain: 'data' }); });
  app.get('/unmanaged', (_req, res) => { res.type('html').send(PAGE_HTML); });
  running = await listen(app);
  await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
  return { baseUrl: running.baseUrl, middleware };
}

describe('node handler auto-head (real Express + compression + etag)', () => {
  it('transforms the managed page: C-2 groups replaced, JSON-LD injected, body untouched', async () => {
    const { baseUrl } = await bootExpress();
    const res = await fetch(`${baseUrl}/managed`, { headers: { 'accept-encoding': 'gzip' } });
    const html = await res.text();
    expect(html).toContain('<title>Managed Title</title>');
    expect(html).not.toContain('App Title');
    expect(html.match(/og:title/g)).toHaveLength(1);
    expect(html).toContain('content="Managed Title"');
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('https://site.test/managed');
    expect(html).toContain('"S-A1"');
    expect(html).toContain(`page body ${'x'.repeat(1500)}`);
    // C-10: transformed responses are plaintext (compression disengaged).
    expect(res.headers.get('content-encoding')).toBe(null);
  });

  it('C-1: our combined ETag replaces the app validator; ours 304s, the app one never does', async () => {
    const { baseUrl } = await bootExpress();
    const first = await fetch(`${baseUrl}/managed`);
    const ourEtag = first.headers.get('etag')!;
    expect(ourEtag).toMatch(/^W\/"sth-1-/);

    const with304 = await fetch(`${baseUrl}/managed`, { headers: { 'if-none-match': ourEtag } });
    expect(with304.status).toBe(304);

    // A stale validator (e.g. the app's own, or ours from an older head
    // state) gets fresh content, never a stale 304.
    const withStale = await fetch(`${baseUrl}/managed`, { headers: { 'if-none-match': 'W/"sth-0-deadbeef"' } });
    expect(withStale.status).toBe(200);
    expect(await withStale.text()).toContain('Managed Title');
  });

  it('C-14: the head-signal guard serves the React page UNTRANSFORMED and flags health', async () => {
    const { baseUrl, middleware } = await bootExpress();
    const res = await fetch(`${baseUrl}/react-page`);
    const html = await res.text();
    expect(html).toContain('<title>React App</title>');
    expect(html).not.toContain('Should Not Appear');
    expect(middleware.bridge.health().flag).toContain('react_hydration_owns_head');
  });

  it('C-4: non-HTML on a head-managed path passes through untouched; unmanaged pages keep compression', async () => {
    const { baseUrl } = await bootExpress();
    const json = await fetch(`${baseUrl}/json-api`);
    expect(await json.json()).toEqual({ plain: 'data' });

    const unmanaged = await fetch(`${baseUrl}/unmanaged`, { headers: { 'accept-encoding': 'gzip' } });
    expect((unmanaged.headers.get('content-encoding') ?? '')).toContain('gzip');
    expect(await unmanaged.text()).toContain('App Title'); // untouched
  });

  it('HEAD on a managed page answers without a corrupted body', async () => {
    const { baseUrl } = await bootExpress();
    const res = await fetch(`${baseUrl}/managed`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('fetch handler auto-head', () => {
  async function makeHandler() {
    const engine = stubEngine(1, STATE);
    const bridge = createBridge({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, autoHead: true });
    await bridge.state!.refreshNow();
    return { bridge, handle: createFetchHandler(bridge) };
  }
  const downstream = (body: string, headers: Record<string, string> = {}) => () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

  it('transforms the managed page and owns the validator', async () => {
    const { handle } = await makeHandler();
    const res = await handle(new Request('https://site.test/managed'), downstream(PAGE_HTML, { etag: '"app-etag"' }));
    const html = await res!.text();
    expect(html).toContain('<title>Managed Title</title>');
    expect(res!.headers.get('etag')).toBe(combinedHeadEtag(1, '"app-etag"'));

    const { handle: handle2 } = await makeHandler();
    const revalidated = await handle2(
      new Request('https://site.test/managed', { headers: { 'if-none-match': combinedHeadEtag(1, '"app-etag"')! } }),
      downstream(PAGE_HTML, { etag: '"app-etag"' }),
    );
    expect(revalidated!.status).toBe(304);
  });

  it('gates: pre-encoded and non-HTML responses pass through; React heads refuse with a flag', async () => {
    const { bridge, handle } = await makeHandler();
    const encoded = await handle(new Request('https://site.test/managed'), downstream(PAGE_HTML, { 'content-encoding': 'gzip' }));
    expect(await encoded!.text()).toContain('App Title'); // untouched — gate refused

    const react = await handle(new Request('https://site.test/react-page'), downstream(REACT_PAGE_HTML));
    expect(await react!.text()).toContain('<title>React App</title>');
    expect(bridge.health().flag).toContain('react_hydration_owns_head');
  });
});
