/**
 * fetch-handler.test.ts — slice 3's canonical WinterCG handler: raw contract
 * (with/without `next`, immutable-header cloning, phase-separated
 * do-no-harm) and a REAL Hono mount — the fetch-family reference framework,
 * itself pure WinterCG, so this doubles as the runtime-compatibility check
 * for the Remix/SvelteKit/Astro/Nuxt recipe class.
 */
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createFetchHandler } from '../src/handlers/fetch.js';
import { createBridge, CONNECTOR_VERSION } from '../src/index.js';
import { TEST_SITE_KEY, TEST_ENGINE_URL, stubEngine } from './helpers.js';

const STATE = {
  robots: 'User-agent: *\nAllow: /\n',
  redirects: [{ from: '/old', to: '/new', statusCode: 308 }],
  headerRules: { '/tagged': { 'X-Robots-Tag': 'noindex', 'X-App-Header': null } },
};

async function makeBridge() {
  const engine = stubEngine(1, STATE);
  const bridge = createBridge({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
  await bridge.state!.refreshNow();
  return bridge;
}

describe('raw fetch-handler contract', () => {
  it('serves managed files/redirects as Responses; undefined means continue', async () => {
    const handle = createFetchHandler(await makeBridge());
    const robots = await handle(new Request('https://site.test/robots.txt'));
    expect(await robots!.text()).toBe(STATE.robots);

    const redirect = await handle(new Request('https://site.test/old'));
    expect(redirect!.status).toBe(308);
    expect(redirect!.headers.get('location')).toBe('https://site.test/new'); // absolutized

    expect(await handle(new Request('https://site.test/unmanaged'))).toBeUndefined();
  });

  it('with `next`: mutates a CLONE of the downstream response (immutable-headers safe)', async () => {
    const handle = createFetchHandler(await makeBridge());
    const downstream = new Response('tagged page', { headers: { 'X-App-Header': 'app-value' } });
    const result = await handle(new Request('https://site.test/tagged'), () => downstream);
    expect(await result!.text()).toBe('tagged page');
    expect(result!.headers.get('x-robots-tag')).toBe('noindex');
    expect(result!.headers.get('x-app-header')).toBe(null);
    expect(downstream.headers.get('x-app-header')).toBe('app-value'); // original untouched
  });

  it('serves the control surface in-handler (single-runtime frameworks own it here)', async () => {
    const handle = createFetchHandler(await makeBridge());
    const ping = await handle(new Request('https://site.test/__signalto/ping?challenge=deadbeef'));
    const body = await ping!.json() as { version: string; signature: string };
    expect(body.version).toBe(CONNECTOR_VERSION);
    expect(body.signature).toBe(createHmac('sha256', TEST_SITE_KEY).update('ping.deadbeef').digest('hex'));
  });

  it('an APP error inside next() propagates untouched', async () => {
    const handle = createFetchHandler(await makeBridge());
    await expect(handle(new Request('https://site.test/boom'), () => { throw new Error('app exploded'); }))
      .rejects.toThrow('app exploded');
  });
});

describe('Hono mount (the documented recipe, verbatim)', () => {
  it('intercepts, mutates, and passes through a real Hono app', async () => {
    const bridge = await makeBridge();
    const handle = createFetchHandler(bridge);
    const app = new Hono();
    // The README recipe, verbatim: mounted first. The `c.res = undefined`
    // reset matters — Hono's res setter otherwise MERGES the old response's
    // headers into the new one, resurrecting headers the bridge removed.
    app.use('*', async (c, next) => {
      const res = await handle(c.req.raw, async () => { await next(); return c.res; });
      if (res && res !== c.res) {
        c.res = undefined as unknown as Response;
        c.res = res;
      }
    });
    app.get('/robots.txt', (c) => c.text('app-owned robots'));
    app.get('/tagged', (c) => { c.header('X-App-Header', 'app-value'); return c.text('tagged page'); });
    app.get('/plain', (c) => c.text('plain page'));

    expect(await (await app.request('https://site.test/robots.txt')).text()).toBe(STATE.robots);

    const redirect = await app.request('https://site.test/old');
    expect(redirect.status).toBe(308);

    const tagged = await app.request('https://site.test/tagged');
    expect(await tagged.text()).toBe('tagged page');
    expect(tagged.headers.get('x-robots-tag')).toBe('noindex');
    expect(tagged.headers.get('x-app-header')).toBe(null);

    expect(await (await app.request('https://site.test/plain')).text()).toBe('plain page');

    const probed = await app.request('https://site.test/plain?__signalto_probe=aa11');
    expect(probed.headers.get('x-signalto-probe'))
      .toBe(createHmac('sha256', TEST_SITE_KEY).update('probe.aa11').digest('hex'));

    const ping = await app.request('https://site.test/__signalto/ping?challenge=beef');
    expect(ping.status).toBe(200);
  });
});
