/**
 * core.test.ts — the WinterCG crypto primitives, doc validation (denylist/
 * allowlist/caps — the D-8 defense-in-depth layer), and the StateClient's
 * SWR contract (last-good on failure, reject-whole on invalid, 401-clear).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, timingSafeEqualHex, verifyHmacHex } from '../src/core/crypto.js';
import { validateStateDoc } from '../src/core/validate.js';
import { StateClient, connectionIdFromSiteKey, EMPTY_STATE } from '../src/core/state.js';
import { TEST_SITE_KEY, stubEngine } from './helpers.js';

describe('core crypto (WinterCG)', () => {
  it('matches node:crypto HMAC-SHA256 hex byte-for-byte (the engine wire contract)', async () => {
    const message = 'state.7.1724500000000.abcdef';
    const expected = createHmac('sha256', TEST_SITE_KEY).update(message).digest('hex');
    expect(await hmacSha256Hex(TEST_SITE_KEY, message)).toBe(expected);
    expect(await verifyHmacHex(TEST_SITE_KEY, message, expected)).toBe(true);
    expect(await verifyHmacHex(TEST_SITE_KEY, message, `${expected.slice(0, -1)}0`)).toBe(false);
  });

  it('timingSafeEqualHex handles length mismatch and garbage without throwing', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'ab')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });

  it('parses the connection id embedded in the site key; malformed keys yield null', () => {
    expect(connectionIdFromSiteKey(TEST_SITE_KEY)).toBe(7);
    expect(connectionIdFromSiteKey('sk_abc')).toBe(null);
    expect(connectionIdFromSiteKey('not-a-key')).toBe(null);
    expect(connectionIdFromSiteKey('sk_0_ab')).toBe(null);
  });
});

describe('state-doc validation (connector-side D-8 defense in depth)', () => {
  const wrap = (doc: unknown) => validateStateDoc(JSON.stringify(doc), 1);

  it('accepts a full valid doc', () => {
    const result = wrap({
      robots: 'User-agent: *\nAllow: /',
      rootFiles: { 'llms.txt': '# hello', '.well-known/foo.json': '{}' },
      redirects: [{ from: '/old', to: '/new', statusCode: 301 }],
      headerRules: { '/page': { 'X-Robots-Tag': 'noindex', 'X-Legacy': null } },
    });
    expect(result.ok).toBe(true);
  });

  it('refuses an unknown schema version BY NAME (keeps last-good, never misreads)', () => {
    const result = validateStateDoc('{}', 2);
    expect(result).toEqual({ ok: false, reason: 'unsupported_schema_version:2' });
  });

  it('rejects the WHOLE doc on a denylisted header — set AND remove directions', () => {
    expect(wrap({ headerRules: { '/p': { 'Set-Cookie': 'x=1' } } })).toMatchObject({ ok: false, reason: 'denylisted_header:Set-Cookie' });
    expect(wrap({ headerRules: { '/p': { 'Strict-Transport-Security': null } } })).toMatchObject({ ok: false });
    expect(wrap({ headerRules: { '/p': { 'Access-Control-Allow-Origin': '*' } } })).toMatchObject({ ok: false });
  });

  it('rejects non-allowlisted root files and control-surface path collisions', () => {
    expect(wrap({ rootFiles: { 'index.html': 'x' } })).toMatchObject({ ok: false });
    expect(wrap({ rootFiles: { '.well-known/../etc': 'x' } })).toMatchObject({ ok: false });
    expect(wrap({ redirects: [{ from: '/__signalto/ping', to: '/x' }] })).toMatchObject({ ok: false });
    expect(wrap({ headerRules: { '/__signalto/state': { 'X-A': 'b' } } })).toMatchObject({ ok: false });
  });

  it('rejects CRLF header values and malformed shapes without throwing', () => {
    expect(wrap({ headerRules: { '/p': { 'X-A': 'evil\r\nInjected: yes' } } })).toMatchObject({ ok: false });
    expect(validateStateDoc('not json', 1)).toMatchObject({ ok: false, reason: 'invalid_json' });
    expect(wrap([])).toMatchObject({ ok: false });
    expect(wrap({ redirects: [{ from: 'no-slash', to: '/x' }] })).toMatchObject({ ok: false });
  });
});

describe('StateClient SWR contract', () => {
  it('serves EMPTY (pass-through) before the first pull lands, then the pulled doc', async () => {
    const engine = stubEngine(3, { robots: 'User-agent: *' });
    const client = new StateClient({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    expect(client.getSnapshot()).toBe(EMPTY_STATE);
    await client.refreshNow();
    expect(client.getSnapshot().version).toBe(3);
    expect(client.getSnapshot().robots).toBe('User-agent: *');
  });

  it('keeps last-good when the engine is unreachable (L-N9)', async () => {
    const engine = stubEngine(1, { robots: 'ok' });
    const client = new StateClient({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, ttlMs: 1 });
    await client.refreshNow();
    expect(client.getSnapshot().robots).toBe('ok');
    engine.setFailure('network');
    await client.refreshNow();
    expect(client.getSnapshot().robots).toBe('ok');
    expect(client.health().lastPullError).toBeTruthy();
  });

  it('rejects an invalid doc WHOLE and keeps last-good', async () => {
    const engine = stubEngine(1, { robots: 'good' });
    const client = new StateClient({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, ttlMs: 1 });
    await client.refreshNow();
    engine.setState(2, { headerRules: { '/p': { 'Set-Cookie': 'evil' } } });
    await client.refreshNow();
    expect(client.getSnapshot().version).toBe(1);
    expect(client.getSnapshot().robots).toBe('good');
    expect(client.health().lastPullError).toContain('doc_rejected');
  });

  it('clears to pass-through after repeated definitive 401s (revoked connection)', async () => {
    const engine = stubEngine(1, { robots: 'managed' });
    const client = new StateClient({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, ttlMs: 1 });
    await client.refreshNow();
    expect(client.getSnapshot().robots).toBe('managed');
    engine.setFailure('unauthorized');
    await client.refreshNow();
    await client.refreshNow();
    expect(client.getSnapshot().robots).toBe('managed'); // not yet — transient tolerance
    await client.refreshNow();
    expect(client.getSnapshot()).toBe(EMPTY_STATE); // third consecutive 401 clears
  });

  it('uses If-None-Match and treats 304 as fresh', async () => {
    const engine = stubEngine(5, { robots: 'v5' });
    const client = new StateClient({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, ttlMs: 1 });
    await client.refreshNow();
    await client.refreshNow();
    const last = engine.calls[engine.calls.length - 1]!;
    expect(last.headers['if-none-match']).toBe('"v5"');
    expect(client.getSnapshot().version).toBe(5);
  });

  it('maybeRefresh is single-flight and never blocks the caller', async () => {
    const engine = stubEngine(1, {});
    engine.setDelayMs(50);
    const client = new StateClient({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, ttlMs: 1 });
    const before = Date.now();
    client.maybeRefresh();
    client.maybeRefresh();
    client.maybeRefresh();
    expect(Date.now() - before).toBeLessThan(20); // sync return while the pull is in flight
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(engine.calls.length).toBe(1); // single-flight
  });
});
