/**
 * review-fixes.test.ts — the behaviours the PR #100 connector review asked
 * for, each pinned by the failure it prevents rather than by the line that
 * changed: outage cadence, the pre-encoded-response gate, write backpressure,
 * the nonce/verify order, auto-head on the buffered adapters, JSON-LD
 * escaping, client-head detection, redirect-target validation, HEAD bodies,
 * and containment when the connector itself throws.
 */
import Fastify from 'fastify';
import Koa from 'koa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { signaltoFastify } from '../src/adapters/fastify.js';
import { signaltoKoa } from '../src/adapters/koa.js';
import { createFetchHandler } from '../src/handlers/fetch.js';
import { ControlSurface } from '../src/core/control.js';
import { StateClient } from '../src/core/state.js';
import { HeadRewriter, headSignalsReactHydration, rewriteHeadString } from '../src/core/headRewriter.js';
import { validateStateDoc } from '../src/core/validate.js';
import { createBridge } from '../src/index.js';
import { TEST_SITE_KEY, TEST_ENGINE_URL, stubEngine } from './helpers.js';

const PAGE_HTML = `<!DOCTYPE html><html><head>
<title>App Title</title>
<meta name="description" content="app description">
</head><body>the body</body></html>`;

const HEAD_STATE = {
  heads: {
    '/managed': { title: 'Managed Title', description: 'Managed description' },
  },
};

/**
 * Joins the background pull that maybeRefresh just started. refreshNow()
 * returns the IN-FLIGHT promise when there is one, so this waits for that
 * exact pull to settle without starting another — deterministic, unlike
 * draining a fixed number of event-loop turns while WebCrypto works.
 */
const joinPull = (client: StateClient): Promise<void> => client.refreshNow();

/**
 * Drains real event-loop turns, for asserting that NOTHING was started. Date
 * is faked in these tests but the loop is not, so a pull that did fire would
 * have recorded its call by the time this resolves.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1 — outage cadence
// ---------------------------------------------------------------------------

describe('state client: an engine outage costs one pull per interval, not one per request', () => {
  it('holds at a single pull across a storm of requests, then retries once the TTL passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const engine = stubEngine(1, {});
    engine.setFailure('network');
    const client = new StateClient({
      engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, ttlMs: 60_000,
    });

    // 200 requests inside one TTL — the pre-fix code pulled on every one.
    for (let i = 0; i < 200; i += 1) client.maybeRefresh();
    await joinPull(client);
    expect(engine.calls).toHaveLength(1);
    expect(client.health().consecutiveFailures).toBe(1);

    // Still inside the interval: no new pull.
    vi.setSystemTime(1_000_000 + 59_999);
    for (let i = 0; i < 50; i += 1) client.maybeRefresh();
    await settle();
    expect(engine.calls).toHaveLength(1);

    // One TTL later: exactly one retry, however many requests arrive.
    vi.setSystemTime(1_000_000 + 60_001);
    for (let i = 0; i < 50; i += 1) client.maybeRefresh();
    await joinPull(client);
    expect(engine.calls).toHaveLength(2);
    expect(client.health().consecutiveFailures).toBe(2);

    // The second failure doubled the wait, so one more TTL is now too soon.
    vi.setSystemTime(1_000_000 + 121_000);
    for (let i = 0; i < 50; i += 1) client.maybeRefresh();
    await settle();
    expect(engine.calls).toHaveLength(2);
  });

  it('a 401 that has not yet hit the clear threshold still backs off, and success resets the ladder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(2_000_000);
    const engine = stubEngine(1, {});
    engine.setFailure('unauthorized');
    const client = new StateClient({
      engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, ttlMs: 60_000,
    });

    for (let i = 0; i < 100; i += 1) client.maybeRefresh();
    await joinPull(client);
    expect(engine.calls).toHaveLength(1);
    expect(client.health().consecutiveUnauthorized).toBe(1);

    // Last-good is untouched by the failure.
    expect(client.getSnapshot().version).toBe(0);

    engine.setFailure(null);
    await client.refreshNow();
    expect(client.health().consecutiveFailures).toBe(0);
    expect(client.getSnapshot().version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3 — the node handler's gate and write contract
// ---------------------------------------------------------------------------

describe('node handler auto-head: encoding gate and write backpressure', () => {
  /** A minimal fake ServerResponse that records writes and reports a full socket. */
  function fakeRes(headers: Record<string, string>) {
    const written: string[] = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      writeCalls: 0,
      callbackCount: 0,
      written,
      getHeader: (name: string) => headers[name.toLowerCase()],
      setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
      removeHeader: (name: string) => { delete headers[name.toLowerCase()]; },
      writeHead(_status?: number, ..._rest: unknown[]) { return res; },
      write(chunk: unknown, encoding?: unknown, callback?: unknown) {
        res.writeCalls += 1;
        written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array));
        const cb = typeof encoding === 'function' ? encoding : callback;
        if (typeof cb === 'function') { res.callbackCount += 1; (cb as () => void)(); }
        return false; // socket is full — the app MUST be told
      },
      end(_chunk?: unknown) { return res; },
    };
    return res;
  }

  async function handlerFor(headers: Record<string, string>) {
    const engine = stubEngine(1, HEAD_STATE);
    const bridge = createBridge({
      engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, autoHead: true,
    });
    await bridge.state!.refreshNow();
    const { createNodeHandler } = await import('../src/handlers/node.js');
    const handle = createNodeHandler(bridge);
    const req = { method: 'GET', url: '/managed', headers: {} as Record<string, unknown> };
    const res = fakeRes(headers);
    await new Promise<void>((resolve) => {
      handle(req as never, res as never, () => resolve());
    });
    return { bridge, res };
  }

  it('a pre-compressed response is passed through with its content-encoding intact', async () => {
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': '18',
    };
    const { res } = await handlerFor(headers);
    const gzipBytes = 'PRETEND-GZIP-BYTES';
    res.writeHead(200);
    (res as unknown as { write(c: unknown): boolean }).write(gzipBytes);
    (res as unknown as { end(): void }).end();
    // Untransformed, and the headers that say how to read it all survive —
    // rewriting the body would have been corruption, stripping the encoding
    // header would have been worse.
    expect(res.written.join('')).toBe(gzipBytes);
    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['content-length']).toBe('18');
  });

  it('write() returns the underlying result once the head is flushed', async () => {
    // The app's own framing headers: both describe the PRE-transform body.
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'content-length': '70',
      'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
    };
    const { res } = await handlerFor(headers);
    const patched = res as unknown as { write(c: unknown, e?: unknown, cb?: unknown): boolean };
    res.writeHead(200);

    // First chunk stops short of </head>: still buffering, nothing written out.
    const buffering = patched.write('<!DOCTYPE html><html><head><title>a</title>');
    expect(buffering).toBe(true);
    expect(res.writeCalls).toBe(0);

    // This chunk completes the head, so the rewriter emits and the socket's
    // refusal (false) must reach the caller verbatim.
    let called = false;
    const flushed = patched.write('</head><body>x</body></html>', undefined, () => { called = true; });
    expect(res.writeCalls).toBeGreaterThan(0);
    expect(flushed).toBe(false);
    expect(called).toBe(true);
    expect(res.written.join('')).toContain('Managed Title');
    // A rewrite changes the length, so the app's framing headers must go:
    // a stale content-length truncates the page in the browser.
    expect(headers['content-length']).toBeUndefined();
    expect(headers['last-modified']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4 — nonce recorded only after the signature verifies
// ---------------------------------------------------------------------------

describe('control surface: a bogus-signature flood cannot lock out the engine', () => {
  const sign = (action: string, timestamp: number, nonce: string) =>
    createHmac('sha256', TEST_SITE_KEY).update(`${action}.${timestamp}.${nonce}`).digest('hex');

  function surface() {
    const engine = stubEngine(1, {});
    const state = new StateClient({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    return new ControlSurface(TEST_SITE_KEY, state, [], null, false);
  }

  const request = (nonce: string, signature: string, timestamp: number) => ({
    method: 'GET',
    subPath: '/capabilities',
    query: new URLSearchParams(),
    header: (name: string) => ({
      'x-signalto-timestamp': String(timestamp),
      'x-signalto-nonce': nonce,
      'x-signalto-signature': signature,
    })[name.toLowerCase()],
  });

  it('a bogus-signature flood never burns the nonces the engine then uses', async () => {
    const control = surface();
    const now = Date.now();
    const bogus = 'f'.repeat(64);

    // The flood, staying inside the token bucket so every request is really
    // evaluated rather than shed at 429.
    for (let i = 0; i < 40; i += 1) {
      const refused = await control.handle(request(`nonce-${i}`, bogus, now), now);
      expect(refused.status).toBe(401);
      expect(JSON.parse(refused.body).error.code).toBe('signature_invalid');
    }

    // The engine's own signed call lands on a nonce the flood already used.
    // Pre-fix the unsigned attempt had CONSUMED it, so this came back
    // nonce_replayed — a 401 the sweep reads as AdapterAuthExpired, i.e. an
    // attacker who never held the site key could fake a revoked connection.
    const nonce = 'nonce-7';
    const ok = await control.handle(request(nonce, sign('capabilities', now, nonce), now), now);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).ok).toBe(true);
  });

  it('replay of a VALID signature is still refused', async () => {
    const control = surface();
    const now = Date.now();
    const nonce = 'once-only';
    const signature = sign('capabilities', now, nonce);
    expect((await control.handle(request(nonce, signature, now), now)).status).toBe(200);
    const replayed = await control.handle(request(nonce, signature, now), now);
    expect(replayed.status).toBe(401);
    expect(JSON.parse(replayed.body).error.code).toBe('nonce_replayed');
  });
});

// ---------------------------------------------------------------------------
// 5 — auto-head on the buffered adapters
// ---------------------------------------------------------------------------

describe('fastify auto-head', () => {
  async function boot(options: { pageHtml?: string; preEncoded?: boolean } = {}) {
    const engine = stubEngine(1, HEAD_STATE);
    const plugin = signaltoFastify({
      engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, autoHead: true,
    });
    const app = Fastify();
    await app.register(plugin);
    app.get('/managed', async (_req, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('etag', '"app-etag"');
      if (options.preEncoded) reply.header('content-encoding', 'gzip');
      return options.pageHtml ?? PAGE_HTML;
    });
    app.get('/unmanaged', async (_req, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      return PAGE_HTML;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => app.close());
    await plugin.bridge.state!.refreshNow();
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return { baseUrl: `http://127.0.0.1:${port}`, bridge: plugin.bridge };
  }

  it('rewrites the managed head, frames content-length, and owns the validator', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/managed`);
    const html = await res.text();
    expect(html).toContain('<title>Managed Title</title>');
    expect(html).not.toContain('App Title');
    expect(html).toContain('content="Managed description"');
    expect(html).toContain('the body');
    expect(res.headers.get('etag')).toMatch(/^W\/"sth-1-/);
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(html));
  });

  it('304s our own validator and leaves unmanaged pages alone', async () => {
    const { baseUrl } = await boot();
    const first = await fetch(`${baseUrl}/managed`);
    const etag = first.headers.get('etag')!;
    await first.text();
    const revalidated = await fetch(`${baseUrl}/managed`, { headers: { 'if-none-match': etag } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');

    const unmanaged = await fetch(`${baseUrl}/unmanaged`);
    expect(await unmanaged.text()).toContain('App Title');
  });

  it('passes a pre-encoded response through untouched, encoding header intact', async () => {
    const { baseUrl } = await boot({ preEncoded: true });
    const res = await fetch(`${baseUrl}/managed`);
    // undici would decode a real gzip body; the header proves we did not
    // claim the payload as ours, and the bytes are the app's own.
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });
});

describe('koa auto-head', () => {
  async function boot(options: { pageHtml?: string } = {}) {
    const engine = stubEngine(1, HEAD_STATE);
    const middleware = signaltoKoa({
      engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, autoHead: true,
    });
    const app = new Koa();
    app.use(middleware as never);
    app.use(async (ctx) => {
      if (ctx.path === '/managed' || ctx.path === '/unmanaged') {
        ctx.type = 'text/html; charset=utf-8';
        ctx.set('etag', '"app-etag"');
        ctx.body = options.pageHtml ?? PAGE_HTML;
        return;
      }
      ctx.status = 404;
      ctx.body = 'nope';
    });
    const server = app.listen(0, '127.0.0.1');
    closers.push(() => new Promise((resolve) => server.close(resolve)));
    await middleware.bridge.state!.refreshNow();
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return { baseUrl: `http://127.0.0.1:${port}`, bridge: middleware.bridge };
  }

  it('rewrites the managed head, frames content-length, and owns the validator', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/managed`);
    const html = await res.text();
    expect(html).toContain('<title>Managed Title</title>');
    expect(html).not.toContain('App Title');
    expect(html).toContain('the body');
    expect(res.headers.get('etag')).toMatch(/^W\/"sth-1-/);
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(html));
  });

  it('304s our own validator and leaves unmanaged pages alone', async () => {
    const { baseUrl } = await boot();
    const first = await fetch(`${baseUrl}/managed`);
    const etag = first.headers.get('etag')!;
    await first.text();
    const revalidated = await fetch(`${baseUrl}/managed`, { headers: { 'if-none-match': etag } });
    expect(revalidated.status).toBe(304);

    const unmanaged = await fetch(`${baseUrl}/unmanaged`);
    expect(await unmanaged.text()).toContain('App Title');
  });

  it('a React-hydrated page is refused by name and served exactly as the app built it', async () => {
    const reactPage = `<!DOCTYPE html><html><head><title>App Title</title>
<script src="/_next/static/chunks/main.js"></script></head><body>the body</body></html>`;
    const { baseUrl, bridge } = await boot({ pageHtml: reactPage });
    const res = await fetch(`${baseUrl}/managed`);
    expect(await res.text()).toContain('<title>App Title</title>');
    expect(bridge.health().flag).toContain('react_hydration_owns_head');
  });
});

describe('capabilities honesty', () => {
  it('every adapter that reports auto_head:true can actually transform a head', async () => {
    const engine = stubEngine(1, HEAD_STATE);
    const state = new StateClient({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    await state.refreshNow();
    const control = new ControlSurface(TEST_SITE_KEY, state, [], null, true);
    const now = Date.now();
    const nonce = 'caps-nonce';
    const signature = createHmac('sha256', TEST_SITE_KEY).update(`capabilities.${now}.${nonce}`).digest('hex');
    const response = await control.handle({
      method: 'GET',
      subPath: '/capabilities',
      query: new URLSearchParams(),
      header: (name: string) => ({
        'x-signalto-timestamp': String(now),
        'x-signalto-nonce': nonce,
        'x-signalto-signature': signature,
      })[name.toLowerCase()],
    }, now);
    expect(JSON.parse(response.body).auto_head).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6 — JSON-LD escaping and client-head detection
// ---------------------------------------------------------------------------

describe('head rewriter: escaping and detection', () => {
  const HEAD = '<html><head><title>t</title></head><body>b</body></html>';

  it('escapes every markup character in JSON-LD, and the data still round-trips', () => {
    const out = rewriteHeadString(HEAD, {
      jsonLd: { '@type': 'Organization', name: 'A < B > C & D', note: '</script><script>alert(1)</script>' },
    });
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(out)![1]!;
    // No raw markup characters survive into the script block.
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(json).toContain('\\u003c');
    // ...and the block cannot have been closed early.
    expect(out.match(/<script/g)).toHaveLength(1);
    // The customer's characters are preserved exactly, not entity-mangled.
    const parsed = JSON.parse(json) as { name: string; note: string };
    expect(parsed.name).toBe('A < B > C & D');
    expect(parsed.note).toBe('</script><script>alert(1)</script>');
  });

  it('refuses a Nuxt-mounted head', () => {
    expect(headSignalsReactHydration('<head><script>window.__NUXT__={data:{}}</script></head>')).toBe(true);
    expect(headSignalsReactHydration('<head><script src="/_nuxt/entry.js"></script></head>')).toBe(true);
    expect(headSignalsReactHydration('<head><script>window.__nuxt = 1</script></head>')).toBe(true);
  });

  it('still refuses Next and SvelteKit, but not prose that merely names them', () => {
    expect(headSignalsReactHydration('<head><script src="/_next/static/a.js"></script></head>')).toBe(true);
    expect(headSignalsReactHydration('<head><script>self.__next_f=[]</script></head>')).toBe(true);
    expect(headSignalsReactHydration('<head><div data-sveltekit-preload-data="hover"></div></head>')).toBe(true);
    // A managed description that talks ABOUT the framework is not a signal.
    expect(headSignalsReactHydration('<head><meta name="description" content="we migrated off /_next/ last year"></head>')).toBe(false);
    expect(headSignalsReactHydration('<head><title>__NEXT_DATA__ explained</title></head>')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7 — the rewriter is Buffer-free
// ---------------------------------------------------------------------------

describe('head rewriter on a WinterCG runtime', () => {
  it('rewrites with Buffer removed from the global scope', () => {
    const saved = (globalThis as { Buffer?: unknown }).Buffer;
    try {
      delete (globalThis as { Buffer?: unknown }).Buffer;
      const rewriter = new HeadRewriter({ title: 'Managed Title' });
      const bytes = new TextEncoder().encode(PAGE_HTML);
      const out = [...rewriter.write(bytes), ...rewriter.end()];
      const text = out.map((chunk) => new TextDecoder().decode(chunk)).join('');
      expect(text).toContain('<title>Managed Title</title>');
      expect(rewriter.outcome().transformed).toBe(true);
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 8 — redirect target validation
// ---------------------------------------------------------------------------

describe('validate: redirect targets', () => {
  const doc = (to: string) => validateStateDoc(JSON.stringify({ redirects: [{ from: '/old', to }] }), 1);

  it('accepts a same-origin path and an absolute https URL', () => {
    expect(doc('/new')).toMatchObject({ ok: true });
    expect(doc('https://example.com/new')).toMatchObject({ ok: true });
  });

  it('refuses header injection, scheme tricks and off-origin protocol-relative targets BY NAME', () => {
    expect(doc('/new\r\nSet-Cookie: a=b')).toMatchObject({ ok: false, reason: 'redirect_to_crlf' });
    expect(doc('/new\nX: y')).toMatchObject({ ok: false, reason: 'redirect_to_crlf' });
    expect(doc('javascript:alert(1)')).toMatchObject({ ok: false, reason: 'redirect_to_not_allowed' });
    expect(doc('http://example.com/new')).toMatchObject({ ok: false, reason: 'redirect_to_not_allowed' });
    expect(doc('//evil.example/new')).toMatchObject({ ok: false, reason: 'redirect_to_not_allowed' });
    expect(doc('data:text/html,<h1>x</h1>')).toMatchObject({ ok: false, reason: 'redirect_to_not_allowed' });
    expect(doc('new-page')).toMatchObject({ ok: false, reason: 'redirect_to_not_allowed' });
  });
});

// ---------------------------------------------------------------------------
// 9 — HEAD requests in the fetch handler
// ---------------------------------------------------------------------------

describe('fetch handler: HEAD', () => {
  it('never takes a reader on the upstream body, so nothing is left locked', async () => {
    const engine = stubEngine(1, HEAD_STATE);
    const bridge = createBridge({
      engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, autoHead: true,
    });
    await bridge.state!.refreshNow();
    const handle = createFetchHandler(bridge);

    const downstream = new Response(PAGE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', etag: '"app-etag"' },
    });
    const res = await handle(new Request('https://site.test/managed', { method: 'HEAD' }), () => downstream);
    expect(res!.status).toBe(200);
    expect(res!.body).toBe(null);
    expect(await res!.text()).toBe('');
    // A reader taken for a body we then throw away leaves the upstream
    // stream locked and never drained — the socket behind it is pinned for
    // as long as the runtime keeps the response alive.
    expect(downstream.body?.locked ?? false).toBe(false);
    expect(res!.headers.get('content-length')).toBe(null);
    expect(res!.headers.get('etag')).toMatch(/^W\/"sth-1-/);
  });
});

// ---------------------------------------------------------------------------
// Containment — a throwing connector must not cost the app its response
// ---------------------------------------------------------------------------

describe('fault injection: a throw inside the connector is contained', () => {
  it('a rewriter that throws still lets the app answer, and raises a health flag', async () => {
    const engine = stubEngine(1, HEAD_STATE);
    const bridge = createBridge({
      engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, autoHead: true,
    });
    await bridge.state!.refreshNow();

    // Poison the managed head so the rewriter throws deep inside the
    // transform (a getter is the closest stand-in for an internal bug).
    const snapshot = bridge.state!.getSnapshot();
    const poisoned = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(poisoned, 'title', {
      enumerable: true,
      get() { throw new Error('connector bug'); },
    });
    (snapshot.heads as Map<string, unknown>).set('/managed', poisoned);

    const handle = createFetchHandler(bridge);
    const res = await handle(
      new Request('https://site.test/managed'),
      () => new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );

    // The app's page still reaches the visitor, whole.
    expect(res!.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain('<title>App Title</title>');
    expect(html).toContain('the body');
    expect(bridge.health().flag).toBeTruthy();
  });
});
