/**
 * interop-pairing.test.ts — spike S-2 as a permanent regression test (the
 * writeHead patch must interoperate with `compression` and `helmet`, the two
 * most common co-patchers of the response head) + the boot pairing flow
 * against a stub engine.
 */
import { createHmac } from 'node:crypto';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { afterEach, describe, expect, it } from 'vitest';
import { signaltoBridge } from '../src/adapters/express.js';
import { attemptPairing, startPairingLoop } from '../src/core/pairing.js';
import { CONNECTOR_VERSION } from '../src/index.js';
import { TEST_SITE_KEY, TEST_ENGINE_URL, listen, stubEngine, waitForStateVersion, type RunningApp } from './helpers.js';

let running: RunningApp | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

describe('S-2: writeHead-patch interop with compression + helmet', () => {
  it('header set+remove still lands with helmet AND compression mounted, body intact', async () => {
    const engine = stubEngine(1, {
      headerRules: { '/page': { 'X-Robots-Tag': 'noindex', 'X-Powered-By-App': null } },
    });
    const middleware = signaltoBridge({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    const app = express();
    app.use(middleware); // bridge FIRST (the documented mount order)
    app.use(helmet());
    app.use(compression({ threshold: 0 }));
    app.get('/page', (_req, res) => {
      res.setHeader('X-Powered-By-App', 'yes');
      res.send('x'.repeat(2048)); // large enough for compression to engage
    });
    running = await listen(app);
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);

    const res = await fetch(`${running.baseUrl}/page`, { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('x'.repeat(2048)); // fetch transparently decompresses — body integrity proof
    expect(res.headers.get('x-robots-tag')).toBe('noindex'); // our set survived both co-patchers
    expect(res.headers.get('x-powered-by-app')).toBe(null); // our removal survived
    expect(res.headers.get('content-security-policy')).toBeTruthy(); // helmet untouched — denylist means we never manage these
  });

  it('managed file serving is unaffected by compression/helmet in the stack', async () => {
    const engine = stubEngine(1, { robots: 'User-agent: *\nAllow: /\n' });
    const middleware = signaltoBridge({ engineUrl: TEST_ENGINE_URL, siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    const app = express();
    app.use(middleware);
    app.use(helmet());
    app.use(compression());
    running = await listen(app);
    await waitForStateVersion(() => middleware.bridge.state!.getSnapshot().version, 1);
    const res = await fetch(`${running.baseUrl}/robots.txt`);
    expect(await res.text()).toBe('User-agent: *\nAllow: /\n');
  });
});

describe('boot pairing (key-possession, no pairing code)', () => {
  /** Stub engine confirm endpoint that verifies the connector's signature exactly like the real route. */
  function confirmStub(behavior: 'ok' | 'reject' | 'flaky') {
    let callCount = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/bridge/node/confirm')) return new Response('{}', { status: 404 });
      callCount += 1;
      if (behavior === 'flaky' && callCount === 1) return new Response('down', { status: 503 });
      if (behavior === 'reject') {
        return new Response(JSON.stringify({ error: { code: 'confirmation_rejected' } }), { status: 400 });
      }
      const body = JSON.parse(String(init?.body)) as {
        connection_id: number; site_url: string; timestamp: number; signature: string;
        control_base: string; connector_version: string;
      };
      expect(body.connection_id).toBe(7); // parsed from sk_7_… — the key names its connection
      const expected = createHmac('sha256', TEST_SITE_KEY)
        .update(`${body.connection_id}.${body.site_url}.${body.timestamp}`)
        .digest('hex');
      if (body.signature !== expected) return new Response('{"error":{"code":"confirmation_rejected"}}', { status: 400 });
      expect(body.control_base).toBe('https://site.test/__signalto');
      expect(body.connector_version).toBe(CONNECTOR_VERSION);
      return new Response(JSON.stringify({ ok: true, connection_id: 7 }), { status: 200 });
    }) as typeof fetch;
    return { fetchFn, calls: () => callCount };
  }

  const options = {
    engineUrl: TEST_ENGINE_URL,
    siteKey: TEST_SITE_KEY,
    siteUrl: 'https://site.test',
    controlBase: 'https://site.test/__signalto',
  };

  it('signs the canonical string the engine verifies and reports confirmed', async () => {
    const stub = confirmStub('ok');
    const result = await attemptPairing({ ...options, fetchFn: stub.fetchFn });
    expect(result).toEqual({ outcome: 'confirmed', connectionId: 7 });
  });

  it('a malformed site key is rejected locally — no request, no retry loop', async () => {
    const stub = confirmStub('ok');
    const result = await attemptPairing({ ...options, siteKey: 'not-a-key', fetchFn: stub.fetchFn });
    expect(result).toEqual({ outcome: 'rejected' });
    expect(stub.calls()).toBe(0);
  });

  it('stops permanently on a definitive 400 (never retries a bad signature)', async () => {
    const stub = confirmStub('reject');
    const loop = startPairingLoop({ ...options, fetchFn: stub.fetchFn });
    await expect(loop.done).resolves.toBe('rejected');
    expect(stub.calls()).toBe(1);
  });

  it('retries transient failures with backoff and then confirms', async () => {
    const stub = confirmStub('flaky');
    const result1 = await attemptPairing({ ...options, fetchFn: stub.fetchFn });
    expect(result1.outcome).toBe('retryable');
    const result2 = await attemptPairing({ ...options, fetchFn: stub.fetchFn });
    expect(result2.outcome).toBe('confirmed');
  });
});
