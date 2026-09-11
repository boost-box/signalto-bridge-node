/**
 * helpers.ts — shared test scaffolding: a canned-engine fetch stub (the
 * connector's ONLY network dependency) and an ephemeral-port Express boot.
 * The app side is REAL HTTP (node http server + undici fetch) — only the
 * engine is stubbed, so interception/pass-through/patching are proven
 * against genuine framework behavior.
 */
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { Express } from 'express';

/** Well-formed test key: sk_<connectionId>_<secret> (the engine's link_site mint shape). */
export const TEST_SITE_KEY = `sk_7_${'ab'.repeat(24)}`;
export const TEST_ENGINE_URL = 'https://engine.test';

export interface StubEngine {
  fetchFn: typeof fetch;
  readonly calls: { url: string; headers: Record<string, string> }[];
  setState(version: number, state: unknown): void;
  setFailure(mode: 'network' | 'unauthorized' | 'server_error' | null): void;
  setDelayMs(ms: number): void;
}

/** In-memory engine double for GET /bridge/node/state — signature-checked like the real route so a connector signing bug fails tests. */
export function stubEngine(initialVersion = 1, initialState: unknown = {}): StubEngine {
  let version = initialVersion;
  let state = initialState;
  let failure: 'network' | 'unauthorized' | 'server_error' | null = null;
  let delayMs = 0;
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({ url, headers });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (failure === 'network') throw new TypeError('fetch failed');
    if (failure === 'unauthorized') return new Response('{"error":{"code":"unauthorized"}}', { status: 401 });
    if (failure === 'server_error') return new Response('boom', { status: 500 });

    if (url.endsWith('/bridge/node/state')) {
      const connectionId = headers['x-signalto-connection-id'];
      const timestamp = headers['x-signalto-timestamp'];
      const nonce = headers['x-signalto-nonce'];
      const expected = createHmac('sha256', TEST_SITE_KEY)
        .update(`state.${connectionId}.${timestamp}.${nonce}`)
        .digest('hex');
      if (headers['x-signalto-signature'] !== expected) {
        return new Response('{"error":{"code":"unauthorized"}}', { status: 401 });
      }
      const etag = `"v${version}"`;
      if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify({ version, schema_version: 1, state }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag },
      });
    }
    return new Response('{"error":{"code":"not_found"}}', { status: 404 });
  }) as typeof fetch;

  return {
    fetchFn,
    calls,
    setState(nextVersion, nextState) { version = nextVersion; state = nextState; },
    setFailure(mode) { failure = mode; },
    setDelayMs(ms) { delayMs = ms; },
  };
}

export interface RunningApp {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export function listen(app: Express): Promise<RunningApp> {
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('no address'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.on('error', reject);
  });
}

/** Deterministic wait for the connector's background pull to land (poll the snapshot version). */
export async function waitForStateVersion(
  getVersion: () => number,
  wanted: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getVersion() >= wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`state version never reached ${wanted} (now ${getVersion()})`);
}
