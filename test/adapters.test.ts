/**
 * adapters.test.ts — the slice-2 framework adapters against REAL frameworks:
 * Fastify (native onRequest/onSend hooks) and Koa (buffered-response
 * mutation), plus the Next.js adapter's injection contract (plain
 * Request/Response + injected makeNext/revalidatePath — no next imports).
 */
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import Koa from 'koa';
import { afterEach, describe, expect, it } from 'vitest';
import { signaltoFastify } from '../src/adapters/fastify.js';
import { signaltoKoa } from '../src/adapters/koa.js';
import { signaltoNextMiddleware, signaltoNextRouteHandlers, signaltoMeta } from '../src/adapters/next.js';
import { createBridge, CONNECTOR_VERSION } from '../src/index.js';
import { TEST_SITE_KEY, TEST_ENGINE_URL, stubEngine, waitForStateVersion } from './helpers.js';

const STATE = {
  robots: 'User-agent: *\nAllow: /\n',
  redirects: [{ from: '/old', to: '/new', statusCode: 301 }],
  headerRules: { '/tagged': { 'X-Robots-Tag': 'noindex', 'X-App-Header': null } },
  slots: { 'meta/how-it-works': { title: 'Managed Title' }, 'content/home-hero': '<p>managed</p>' },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('Fastify adapter (native hooks)', () => {
  async function bootFastify() {
    const engine = stubEngine(1, STATE);
    const plugin = signaltoFastify({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    const app = Fastify({ logger: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(plugin as any);
    app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('app-owned robots'));
    app.get('/tagged', async (_req, reply) => {
      reply.header('X-App-Header', 'app-value');
      return 'tagged page';
    });
    app.get('/plain', async () => 'plain page');
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    await waitForStateVersion(() => plugin.bridge.state!.getSnapshot().version, 1);
    return { baseUrl, plugin };
  }

  it('intercepts robots + redirects, mutates headers via onSend, passes everything else', async () => {
    const { baseUrl } = await bootFastify();
    expect(await (await fetch(`${baseUrl}/robots.txt`)).text()).toBe(STATE.robots);

    const redirect = await fetch(`${baseUrl}/old`, { redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/new');

    const tagged = await fetch(`${baseUrl}/tagged`);
    expect(await tagged.text()).toBe('tagged page');
    expect(tagged.headers.get('x-robots-tag')).toBe('noindex');
    expect(tagged.headers.get('x-app-header')).toBe(null);

    expect(await (await fetch(`${baseUrl}/plain`)).text()).toBe('plain page');
  });

  it('serves the control surface and the probe echo', async () => {
    const { baseUrl } = await bootFastify();
    const ping = await fetch(`${baseUrl}/__signalto/ping?challenge=deadbeef`);
    const body = await ping.json() as { signature: string; version: string };
    expect(body.version).toBe(CONNECTOR_VERSION);
    expect(body.signature).toBe(createHmac('sha256', TEST_SITE_KEY).update('ping.deadbeef').digest('hex'));

    const probed = await fetch(`${baseUrl}/plain?__signalto_probe=aa11`);
    expect(probed.headers.get('x-signalto-probe'))
      .toBe(createHmac('sha256', TEST_SITE_KEY).update('probe.aa11').digest('hex'));
  });
});

describe('Koa adapter (buffered mutation)', () => {
  async function bootKoa() {
    const engine = stubEngine(1, STATE);
    const middleware = signaltoKoa({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    const app = new Koa();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use(middleware as any);
    app.use(async (ctx) => {
      if (ctx.path === '/robots.txt') { ctx.type = 'text/plain'; ctx.body = 'app-owned robots'; return; }
      if (ctx.path === '/tagged') { ctx.set('X-App-Header', 'app-value'); ctx.body = 'tagged page'; return; }
      if (ctx.path === '/boom') throw new Error('app exploded');
      ctx.body = 'plain page';
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    return { baseUrl: `http://127.0.0.1:${address.port}`, middleware };
  }

  it('intercepts, redirects, and mutates headers after the app renders', async () => {
    const { baseUrl } = await bootKoa();
    expect(await (await fetch(`${baseUrl}/robots.txt`)).text()).toBe(STATE.robots);

    const redirect = await fetch(`${baseUrl}/old`, { redirect: 'manual' });
    expect(redirect.status).toBe(301);

    const tagged = await fetch(`${baseUrl}/tagged`);
    expect(await tagged.text()).toBe('tagged page');
    expect(tagged.headers.get('x-robots-tag')).toBe('noindex');
    expect(tagged.headers.get('x-app-header')).toBe(null);
  });

  it('an APP error propagates to Koa untouched — the bridge neither swallows nor re-runs it', async () => {
    const { baseUrl } = await bootKoa();
    const res = await fetch(`${baseUrl}/boom`);
    expect(res.status).toBe(500); // Koa's own error handling, not ours
  });
});

describe('Next.js adapter (injection contract, no next imports)', () => {
  function makeBridge(overrides: Record<string, unknown> = {}) {
    const engine = stubEngine(1, STATE);
    const bridge = createBridge({
      engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn,
      slots: [
        { opType: 'meta', name: 'how-it-works', path: '/how-it-works', mode: 'static' },
        { opType: 'content', name: 'home-hero', path: '/', mode: 'isr' },
      ],
      ...overrides,
    });
    return { engine, bridge };
  }

  it('middleware serves managed files as plain Responses and applies header rules through makeNext', async () => {
    const { bridge } = makeBridge();
    await bridge.state!.refreshNow();
    const middleware = signaltoNextMiddleware(bridge);

    const robots = await middleware(new Request('https://site.test/robots.txt'));
    expect(robots).toBeInstanceOf(Response);
    expect(await robots!.text()).toBe(STATE.robots);

    const redirect = await middleware(new Request('https://site.test/old'));
    expect(redirect!.status).toBe(301);
    // Live UAT finding: Next rejects relative Location from middleware —
    // the adapter absolutizes against the request URL.
    expect(redirect!.headers.get('location')).toBe('https://site.test/new');

    const pass = await middleware(new Request('https://site.test/unmanaged'));
    expect(pass).toBeUndefined(); // Next continues

    // Control paths pass through — the route handler owns them (live UAT
    // finding: the edge instance answering control calls broke revalidation).
    const control = await middleware(new Request('https://site.test/__signalto/ping?challenge=abcd'));
    expect(control).toBeUndefined();

    const next = new Response(null); // stands in for NextResponse.next()
    next.headers.set('X-App-Header', 'app-value');
    const mutated = await middleware(new Request('https://site.test/tagged'), () => next);
    expect(mutated).toBe(next);
    expect(mutated!.headers.get('x-robots-tag')).toBe('noindex');
    expect(mutated!.headers.get('x-app-header')).toBe(null);
  });

  it('route handlers serve the control surface and wire revalidatePath as the S-5 hook', async () => {
    const { engine, bridge } = makeBridge();
    await bridge.state!.refreshNow();
    const revalidated: string[] = [];
    const { POST } = signaltoNextRouteHandlers(bridge, { revalidatePath: (path) => revalidated.push(path) });

    engine.setState(2, { ...STATE, slots: { ...STATE.slots, 'content/home-hero': '<p>updated</p>' } });
    const timestamp = Date.now();
    const nonce = 'e2e-nonce-1';
    const signature = createHmac('sha256', TEST_SITE_KEY).update(`refresh.${timestamp}.${nonce}`).digest('hex');
    const res = await POST(new Request('https://site.test/__signalto/refresh', {
      method: 'POST',
      headers: {
        'x-signalto-timestamp': String(timestamp),
        'x-signalto-nonce': nonce,
        'x-signalto-signature': signature,
      },
    }));
    expect(res.status).toBe(200);
    expect(revalidated).toEqual(['/']); // only the changed slot's route

    // generateMetadata sugar: managed fields merge over the wired fallback.
    const merged = await signaltoMeta(bridge, 'how-it-works', { title: 'Fallback', description: 'Kept' });
    expect(merged).toEqual({ title: 'Managed Title', description: 'Kept' });
  });
});
