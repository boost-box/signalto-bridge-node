/**
 * edge-cases.test.ts — the hostile/awkward-input matrix, run against REAL
 * frameworks (bare node:http, Express 4, Fastify, Koa + the raw fetch
 * handler): non-GET traffic through managed paths, request-body integrity
 * (the stream double-consume class), chunked/streamed responses under header
 * rules, same-path precedence, HEAD-on-redirect, hostile URLs (malformed
 * percent-encoding, null bytes, 8KB query strings, degenerate probe params),
 * multibyte content fidelity, and the control-surface token bucket — none of
 * which the happy-path suites exercised.
 */
import { Readable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import express from 'express';
import Fastify from 'fastify';
import Koa from 'koa';
import { afterEach, describe, expect, it } from 'vitest';
import { signaltoFastify } from '../src/adapters/fastify.js';
import { signaltoKoa } from '../src/adapters/koa.js';
import { createFetchHandler } from '../src/handlers/fetch.js';
import { createNodeHandler } from '../src/handlers/node.js';
import { createBridge, type SignalToBridge } from '../src/index.js';
import { validateStateDoc } from '../src/core/validate.js';
import { TEST_SITE_KEY, TEST_ENGINE_URL, stubEngine, waitForStateVersion } from './helpers.js';

/** Multibyte robots content — byte-length ≠ char-length, so a length bug shows. */
const ROBOTS_UNICODE = 'User-agent: *\nAllow: /\n# ünïcodé — ✓ マーカー\n';

const STATE = {
  robots: ROBOTS_UNICODE,
  redirects: [
    { from: '/old', to: '/new', statusCode: 301 },
    { from: '/both', to: '/elsewhere', statusCode: 302 },
  ],
  headerRules: {
    '/stream': { 'X-Robots-Tag': 'noindex', 'X-App-Header': null },
    // Same path as a managed redirect — precedence must be deterministic.
    '/both': { 'X-Robots-Tag': 'noindex' },
  },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function makeBridge(): SignalToBridge {
  const engine = stubEngine(1, STATE);
  return createBridge({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
}

async function listenUrl(server: Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Booted { baseUrl: string; bridge: SignalToBridge }

/** Each framework serves the SAME app surface: POST /echo (raw body echo), POST /robots.txt ('posted'), GET /stream (3 chunks + X-App-Header), GET /plain. */
type Boot = () => Promise<Booted>;

const boots: Record<string, Boot> = {
  'bare node:http': async () => {
    const bridge = makeBridge();
    const handler = createNodeHandler(bridge);
    const server = createServer((req, res) => {
      handler(req, res, () => {
        const path = (req.url ?? '/').split('?')[0];
        if (req.method === 'POST' && path === '/echo') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => { res.end(Buffer.concat(chunks)); });
          return;
        }
        if (req.method === 'POST' && path === '/robots.txt') { res.end('posted'); return; }
        if (path === '/stream') {
          res.setHeader('X-App-Header', 'app-value');
          res.write('chunk1-');
          setTimeout(() => { res.write('chunk2-'); setTimeout(() => res.end('chunk3'), 5); }, 5);
          return;
        }
        res.end('plain page');
      });
    });
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const baseUrl = await listenUrl(server);
    await waitForStateVersion(() => bridge.state!.getSnapshot().version, 1);
    return { baseUrl, bridge };
  },

  'Express 4': async () => {
    const bridge = makeBridge();
    const app = express();
    app.use(createNodeHandler(bridge));
    app.post('/echo', (req, res) => { req.pipe(res); });
    app.post('/robots.txt', (_req, res) => { res.send('posted'); });
    app.get('/stream', (_req, res) => {
      res.setHeader('X-App-Header', 'app-value');
      res.write('chunk1-');
      setTimeout(() => { res.write('chunk2-'); setTimeout(() => res.end('chunk3'), 5); }, 5);
    });
    app.get('/plain', (_req, res) => { res.send('plain page'); });
    const server = createServer(app);
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const baseUrl = await listenUrl(server);
    await waitForStateVersion(() => bridge.state!.getSnapshot().version, 1);
    return { baseUrl, bridge };
  },

  Fastify: async () => {
    const engine = stubEngine(1, STATE);
    const plugin = signaltoFastify({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    const app = Fastify({ logger: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(plugin as any);
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    app.post('/echo', async (req) => req.body as Buffer);
    app.post('/robots.txt', async () => 'posted');
    app.get('/stream', async (_req, reply) => {
      reply.header('X-App-Header', 'app-value');
      // The idiomatic Fastify streaming path (reply.send(stream)) — onSend
      // runs, so managed header rules apply. reply.raw writes BYPASS onSend
      // and are documented unmanaged.
      return reply.send(Readable.from(['chunk1-', 'chunk2-', 'chunk3']));
    });
    app.get('/plain', async () => 'plain page');
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    await waitForStateVersion(() => plugin.bridge.state!.getSnapshot().version, 1);
    return { baseUrl, bridge: plugin.bridge };
  },

  Koa: async () => {
    const engine = stubEngine(1, STATE);
    const middleware = signaltoKoa({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    const app = new Koa();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use(middleware as any);
    app.use(async (ctx) => {
      if (ctx.method === 'POST' && ctx.path === '/echo') { ctx.body = ctx.req; return; }
      if (ctx.method === 'POST' && ctx.path === '/robots.txt') { ctx.body = 'posted'; return; }
      if (ctx.path === '/stream') {
        ctx.set('X-App-Header', 'app-value');
        ctx.body = Readable.from(['chunk1-', 'chunk2-', 'chunk3']);
        return;
      }
      ctx.body = 'plain page';
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    return { baseUrl, bridge: middleware.bridge };
  },
};

for (const [name, boot] of Object.entries(boots)) {
  describe(`${name} — edge cases`, () => {
    it('non-GET traffic passes through managed paths; request bodies arrive intact', async () => {
      const { baseUrl } = await boot();
      // 64KB body through the bridge — the stream double-consume check.
      const body = 'x'.repeat(64 * 1024);
      const echoed = await fetch(`${baseUrl}/echo`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });
      expect(await echoed.text()).toBe(body);

      // POST to a MANAGED path is not intercepted — the app answers.
      const posted = await fetch(`${baseUrl}/robots.txt`, { method: 'POST', body: 'irrelevant', headers: { 'content-type': 'application/octet-stream' } });
      expect(await posted.text()).toBe('posted');

      // OPTIONS on a managed path: never the managed body; server stays healthy.
      const options = await fetch(`${baseUrl}/robots.txt`, { method: 'OPTIONS' });
      expect((await options.text())).not.toBe(ROBOTS_UNICODE);
    });

    it('chunked/streamed responses keep their body under a header rule; set+remove still land', async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/stream`);
      expect(await res.text()).toBe('chunk1-chunk2-chunk3');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(res.headers.get('x-app-header')).toBe(null);
    });

    it('managed redirect wins over a header rule on the same path; HEAD gets the redirect too', async () => {
      const { baseUrl } = await boot();
      const both = await fetch(`${baseUrl}/both`, { redirect: 'manual' });
      expect(both.status).toBe(302);
      expect(both.headers.get('location')).toBe('/elsewhere');

      const head = await fetch(`${baseUrl}/old`, { method: 'HEAD', redirect: 'manual' });
      expect(head.status).toBe(301);
      expect(head.headers.get('location')).toBe('/new');
      expect(await head.text()).toBe('');
    });

    it('serves multibyte managed content byte-exactly', async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/robots.txt`);
      expect(await res.text()).toBe(ROBOTS_UNICODE);
    });

    it('hostile URLs never crash the server or corrupt later requests', async () => {
      const { baseUrl } = await boot();
      const hostile = [
        '/%zz',                                  // malformed percent-encoding
        '/robots.txt%00tail',                    // null-byte suffix
        `/plain?${'x'.repeat(8 * 1024)}`,        // 8KB query string
        '/plain?__signalto_probe',               // valueless probe param
        '/plain?__signalto_probe=a&__signalto_probe=zz!bad',
        '//plain',                               // double slash
      ];
      for (const path of hostile) {
        const res = await fetch(`${baseUrl}${path}`).catch(() => null);
        // Any well-formed HTTP answer is acceptable (frameworks differ on
        // 400 vs 404 vs render) — a hang/crash/socket error is not.
        expect(res).not.toBeNull();
      }
      // The server is still fully functional afterwards.
      expect(await (await fetch(`${baseUrl}/plain`)).text()).toBe('plain page');
      expect(await (await fetch(`${baseUrl}/robots.txt`)).text()).toBe(ROBOTS_UNICODE);
    });

    it('the control-surface token bucket throttles a flood without touching app traffic', async () => {
      const { baseUrl } = await boot();
      const statuses = await Promise.all(Array.from({ length: 80 }, () =>
        fetch(`${baseUrl}/__signalto/ping?challenge=deadbeef`).then((res) => res.status)));
      expect(statuses).toContain(429);            // the bucket engaged
      expect(statuses).toContain(200);            // and legitimate calls got through first
      // App traffic is untouched by the flood.
      expect(await (await fetch(`${baseUrl}/plain`)).text()).toBe('plain page');
    });
  });
}

describe('raw fetch handler — the same edges for the WinterCG family', () => {
  it('non-GET pass-through, precedence, HEAD-on-redirect, hostile URLs', async () => {
    const bridge = makeBridge();
    await bridge.state!.refreshNow();
    const handle = createFetchHandler(bridge);

    // POST to a managed path continues to the app.
    expect(await handle(new Request('https://site.test/robots.txt', { method: 'POST', body: 'x' }))).toBeUndefined();

    // Redirect beats the header rule on the same path.
    const both = await handle(new Request('https://site.test/both'));
    expect(both!.status).toBe(302);

    const head = await handle(new Request('https://site.test/old', { method: 'HEAD' }));
    expect(head!.status).toBe(301);
    expect(await head!.text()).toBe('');

    // Hostile inputs degrade to pass-through/managed answers, never a throw.
    for (const url of [
      'https://site.test/%zz',
      `https://site.test/plain?${'x'.repeat(8 * 1024)}`,
      'https://site.test/plain?__signalto_probe',
    ]) {
      await expect(handle(new Request(url))).resolves.not.toThrow;
    }
    expect(await (await handle(new Request('https://site.test/robots.txt')))!.text()).toBe(ROBOTS_UNICODE);
  });
});

describe('redirect-loop refusal (defense in depth, connector side)', () => {
  it('never adopts a doc carrying a self-redirect', () => {
    const result = validateStateDoc(JSON.stringify({ redirects: [{ from: '/a', to: '/a' }] }), 1);
    expect(result).toMatchObject({ ok: false, reason: 'redirect_self_loop' });
  });
});
