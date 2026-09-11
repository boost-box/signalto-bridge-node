/**
 * frameworks-extended.test.ts — real-framework integration for the rest of
 * the documented mount surface: bare node:http (the canonical handler with
 * no framework at all), Express 5 (the README claims 4/5 — 4 is covered in
 * handler.test.ts, this is the 5 half), hapi (the onRequest-extension
 * recipe), and h3 — Nuxt's actual server engine, so this is the Nuxt
 * recipe's substrate tested for real.
 *
 * Remix / SvelteKit / Astro SSR are deliberately NOT here: they consume the
 * same WinterCG `(Request) => Response` contract fetch-handler.test.ts
 * proves (raw + through real Hono), but driving the real frameworks needs
 * their vite/react build pipelines — an app-build-scale test that belongs
 * with the S-1-class deploy checks, not this unit-fast suite.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Hapi from '@hapi/hapi';
import { createApp, defineEventHandler, fromNodeMiddleware, toNodeListener, setResponseHeader } from 'h3';
// Express 5 under an npm alias — the README's "Express 4/5" claim, 5 half.
import express5 from 'express5';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeHandler } from '../src/handlers/node.js';
import { createBridge } from '../src/index.js';
import { TEST_SITE_KEY, TEST_ENGINE_URL, stubEngine, waitForStateVersion } from './helpers.js';

const STATE = {
  robots: 'User-agent: *\nAllow: /\n',
  redirects: [{ from: '/old', to: '/new', statusCode: 301 }],
  headerRules: { '/tagged': { 'X-Robots-Tag': 'noindex', 'X-App-Header': null } },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function trackServer(server: Server): void {
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
}

async function listenUrl(server: Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

function makeMounted() {
  const engine = stubEngine(1, STATE);
  const bridge = createBridge({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
  return { bridge, handler: createNodeHandler(bridge) };
}

/** The shared assertion set: interception, redirect, header set+remove over the app's own, pass-through, probe echo, control ping. */
async function assertBridgeBehaviors(baseUrl: string) {
  expect(await (await fetch(`${baseUrl}/robots.txt`)).text()).toBe(STATE.robots);

  const redirect = await fetch(`${baseUrl}/old`, { redirect: 'manual' });
  expect(redirect.status).toBe(301);
  expect(redirect.headers.get('location')).toBe('/new');

  const tagged = await fetch(`${baseUrl}/tagged`);
  expect(await tagged.text()).toBe('tagged page');
  expect(tagged.headers.get('x-robots-tag')).toBe('noindex');
  expect(tagged.headers.get('x-app-header')).toBe(null);

  expect(await (await fetch(`${baseUrl}/plain`)).text()).toBe('plain page');

  const probed = await fetch(`${baseUrl}/plain?__signalto_probe=aa11`);
  expect(probed.headers.get('x-signalto-probe'))
    .toBe(createHmac('sha256', TEST_SITE_KEY).update('probe.aa11').digest('hex'));

  const ping = await fetch(`${baseUrl}/__signalto/ping?challenge=deadbeef`);
  expect(ping.status).toBe(200);
  expect(((await ping.json()) as { signature: string }).signature)
    .toBe(createHmac('sha256', TEST_SITE_KEY).update('ping.deadbeef').digest('hex'));
}

describe('bare node:http (no framework)', () => {
  it('the canonical handler runs standalone with a plain-http app behind it', async () => {
    const { bridge, handler } = makeMounted();
    const server = createServer((req, res) => {
      handler(req, res, () => {
        const path = (req.url ?? '/').split('?')[0];
        if (path === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('app-owned robots'); return; }
        if (path === '/tagged') { res.setHeader('X-App-Header', 'app-value'); res.end('tagged page'); return; }
        res.end('plain page');
      });
    });
    trackServer(server);
    const baseUrl = await listenUrl(server);
    await waitForStateVersion(() => bridge.state!.getSnapshot().version, 1);
    await assertBridgeBehaviors(baseUrl);
  });
});

describe('Express 5', () => {
  it('the express adapter surface works unchanged on the 5.x router', async () => {
    const { bridge, handler } = makeMounted();
    const app = express5();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use(handler as any);
    app.get('/robots.txt', (_req: unknown, res: { type: (t: string) => { send: (b: string) => void } }) => res.type('text/plain').send('app-owned robots'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.get('/tagged', (_req: any, res: any) => { res.setHeader('X-App-Header', 'app-value'); res.send('tagged page'); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.get('/plain', (_req: any, res: any) => res.send('plain page'));
    const server = createServer(app);
    trackServer(server);
    const baseUrl = await listenUrl(server);
    await waitForStateVersion(() => bridge.state!.getSnapshot().version, 1);
    await assertBridgeBehaviors(baseUrl);
  });
});

describe('hapi (onRequest extension — the README recipe)', () => {
  it('intercepts before hapi routing; pass-through reaches hapi handlers; header rules apply', async () => {
    const { bridge, handler } = makeMounted();
    const server = Hapi.server({ port: 0, host: '127.0.0.1' });
    // The README recipe: run the node handler on the raw req/res; if it
    // responds, abandon hapi's own lifecycle for that request.
    server.ext('onRequest', (request, h) => new Promise((resolve) => {
      const { req, res } = request.raw;
      res.once('finish', () => resolve(h.abandon));
      handler(req, res, () => resolve(h.continue));
    }));
    server.route({ method: 'GET', path: '/robots.txt', handler: (_r, h) => h.response('app-owned robots').type('text/plain') });
    server.route({ method: 'GET', path: '/tagged', handler: (_r, h) => h.response('tagged page').header('X-App-Header', 'app-value') });
    server.route({ method: 'GET', path: '/plain', handler: () => 'plain page' });
    await server.start();
    cleanups.push(() => server.stop());
    const baseUrl = `http://127.0.0.1:${server.info.port}`;
    await waitForStateVersion(() => bridge.state!.getSnapshot().version, 1);
    await assertBridgeBehaviors(baseUrl);
  });
});

describe('h3 v1 (the CURRENT Nuxt server engine — the Nuxt recipe substrate)', () => {
  it('fromNodeMiddleware mounts the canonical handler first; header rules survive h3 rendering', async () => {
    const { createApp: createAppV1, defineEventHandler: handlerV1, fromNodeMiddleware: fromNodeV1, toNodeListener: toListenerV1, setResponseHeader: setHeaderV1 } = await import('h3v1');
    const { bridge, handler } = makeMounted();
    const app = createAppV1();
    // The README's Nuxt recipe substrate: server middleware wrapping the
    // canonical node handler, registered FIRST.
    app.use(fromNodeV1(handler));
    app.use('/robots.txt', handlerV1((event) => {
      setHeaderV1(event, 'content-type', 'text/plain');
      return 'app-owned robots';
    }));
    app.use('/tagged', handlerV1((event) => {
      setHeaderV1(event, 'X-App-Header', 'app-value');
      return 'tagged page';
    }));
    app.use('/plain', handlerV1(() => 'plain page'));
    const server = createServer(toListenerV1(app));
    trackServer(server);
    const baseUrl = await listenUrl(server);
    await waitForStateVersion(() => bridge.state!.getSnapshot().version, 1);
    await assertBridgeBehaviors(baseUrl);
  });
});

describe('h3 v2-rc (the NEXT Nitro engine — commits headers via the writeHead ARRAY form)', () => {
  it('header removal survives the raw-headers-array writeHead path (the patch gap this test found)', async () => {
    const { bridge, handler } = makeMounted();
    const app = createApp();
    app.use(fromNodeMiddleware(handler));
    app.use('/robots.txt', defineEventHandler((event) => {
      setResponseHeader(event, 'content-type', 'text/plain');
      return 'app-owned robots';
    }));
    app.use('/tagged', defineEventHandler((event) => {
      setResponseHeader(event, 'X-App-Header', 'app-value');
      return 'tagged page';
    }));
    app.use('/plain', defineEventHandler(() => 'plain page'));
    const server = createServer(toNodeListener(app));
    trackServer(server);
    const baseUrl = await listenUrl(server);
    await waitForStateVersion(() => bridge.state!.getSnapshot().version, 1);
    await assertBridgeBehaviors(baseUrl);
  });
});
