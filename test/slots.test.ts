/**
 * slots.test.ts — slice 2's slot surface: doc validation, the sync/async
 * slot accessors (cold-start fallback contract), the signed /read read-back
 * (the engine's verification of record, D-12), wired-slot reporting with the
 * revalidate flag, and the refresh diff that drives the S-5 revalidation
 * hook.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBridge, CONNECTOR_VERSION } from '../src/index.js';
import { validateStateDoc } from '../src/core/validate.js';
import { TEST_SITE_KEY, stubEngine } from './helpers.js';

const signedHeaders = (action: string) => {
  const timestamp = Date.now();
  const nonce = `${timestamp.toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  return {
    'x-signalto-timestamp': String(timestamp),
    'x-signalto-nonce': nonce,
    'x-signalto-signature': createHmac('sha256', TEST_SITE_KEY).update(`${action}.${timestamp}.${nonce}`).digest('hex'),
  };
};

const controlRequest = (subPath: string, method: string, headers: Record<string, string>, query = '') => ({
  method,
  subPath,
  query: new URLSearchParams(query),
  header: (name: string) => headers[name.toLowerCase()],
});

describe('slot doc validation', () => {
  const wrap = (slots: unknown) => validateStateDoc(JSON.stringify({ slots }), 1);

  it('accepts valid meta/schema/content slot values', () => {
    expect(wrap({
      'meta/how-it-works': { title: 'How it works', description: 'x' },
      'schema/org': { '@type': 'Organization', name: 'Acme' },
      'content/home-hero': '<p>hero</p>',
    }).ok).toBe(true);
  });

  it('rejects malformed keys, unknown meta fields, and wrong value types WHOLE', () => {
    expect(wrap({ 'robots_txt/x': 'nope' })).toMatchObject({ ok: false });
    expect(wrap({ 'meta/x': { evilField: 'y' } })).toMatchObject({ ok: false, reason: 'invalid_meta_field:meta/x.evilField' });
    expect(wrap({ 'content/x': { not: 'a string' } })).toMatchObject({ ok: false });
    expect(wrap({ 'schema/x': 'not an object' })).toMatchObject({ ok: false });
  });
});

describe('slot accessors', () => {
  it('slot() serves the managed value after a pull, fallback before/without one', async () => {
    const engine = stubEngine(1, { slots: { 'content/home-hero': '<p>managed hero</p>' } });
    const bridge = createBridge({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    expect(bridge.slot('content', 'home-hero', 'fallback')).toBe('fallback'); // pre-pull
    await bridge.state!.refreshNow();
    expect(bridge.slot('content', 'home-hero', 'fallback')).toBe('<p>managed hero</p>');
    expect(bridge.slot('content', 'unwired', 'fallback')).toBe('fallback');
  });

  it('slotAsync() waits for the first pull but renders the fallback under an engine outage (never hangs)', async () => {
    const engine = stubEngine(1, { slots: { 'meta/p': { title: 'Managed' } } });
    const bridge = createBridge({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn });
    expect(await bridge.slotAsync('meta', 'p', null)).toEqual({ title: 'Managed' }); // first pull awaited

    const deadEngine = stubEngine(1, {});
    deadEngine.setDelayMs(10_000); // an engine that hangs far beyond the helper's cap
    const coldBridge = createBridge({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: deadEngine.fetchFn });
    const before = Date.now();
    expect(await coldBridge.slotAsync('meta', 'p', { title: 'Fallback' }, 200)).toEqual({ title: 'Fallback' });
    expect(Date.now() - before).toBeLessThan(2_000);
  });
});

describe('control surface: /read, wired_slots, refresh revalidation', () => {
  const SLOTS = [
    { opType: 'meta' as const, name: 'how-it-works', path: '/how-it-works', mode: 'static' as const },
    { opType: 'content' as const, name: 'home-hero', path: '/', mode: 'isr' as const },
  ];

  it('/read returns the value the app currently renders from (signed; null when unmanaged)', async () => {
    const engine = stubEngine(3, { slots: { 'content/home-hero': '<p>v3</p>' } });
    const bridge = createBridge({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, slots: SLOTS });
    await bridge.state!.refreshNow();

    const ok = await bridge.handleControl(controlRequest('/read', 'GET', signedHeaders('read'), 'slot=content%2Fhome-hero'));
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ slot: 'content/home-hero', value: '<p>v3</p>', state_version: 3 });

    const unmanaged = await bridge.handleControl(controlRequest('/read', 'GET', signedHeaders('read'), 'slot=meta%2Fhow-it-works'));
    expect(JSON.parse(unmanaged.body)).toMatchObject({ value: null });

    const unsigned = await bridge.handleControl(controlRequest('/read', 'GET', {}, 'slot=content%2Fhome-hero'));
    expect(unsigned.status).toBe(401);

    const badKey = await bridge.handleControl(controlRequest('/read', 'GET', signedHeaders('read'), 'slot=__proto__%2Fx'));
    expect(badKey.status).toBe(400);
  });

  it('/capabilities reports wired slots with revalidate=false without a hook, true with one', async () => {
    const engine = stubEngine(1, {});
    const noHook = createBridge({ engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, slots: SLOTS });
    const withoutHook = await noHook.handleControl(controlRequest('/capabilities', 'GET', signedHeaders('capabilities')));
    const reportA = JSON.parse(withoutHook.body) as { version: string; wired_slots: { name: string; revalidate: boolean }[] };
    expect(reportA.version).toBe(CONNECTOR_VERSION);
    expect(reportA.wired_slots).toHaveLength(2);
    expect(reportA.wired_slots.every((slot) => slot.revalidate === false)).toBe(true);

    const withHook = createBridge({
      engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, slots: SLOTS,
      onSlotsChanged: () => undefined,
    });
    const hooked = await withHook.handleControl(controlRequest('/capabilities', 'GET', signedHeaders('capabilities')));
    const reportB = JSON.parse(hooked.body) as { wired_slots: { op_type: string; name: string; path: string; mode: string; revalidate: boolean }[] };
    expect(reportB.wired_slots).toEqual([
      { op_type: 'meta', name: 'how-it-works', path: '/how-it-works', mode: 'static', revalidate: true },
      { op_type: 'content', name: 'home-hero', path: '/', mode: 'isr', revalidate: true },
    ]);
  });

  it('POST /refresh diffs slot values and calls the revalidation hook with ONLY the changed routes (S-5)', async () => {
    const engine = stubEngine(1, { slots: { 'content/home-hero': '<p>v1</p>', 'meta/how-it-works': { title: 'A' } } });
    const revalidated: string[][] = [];
    const bridge = createBridge({
      engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, slots: SLOTS,
      onSlotsChanged: (paths) => { revalidated.push([...paths]); },
    });
    await bridge.state!.refreshNow();

    // Only the hero slot changes; the meta slot is byte-identical.
    engine.setState(2, { slots: { 'content/home-hero': '<p>v2</p>', 'meta/how-it-works': { title: 'A' } } });
    const res = await bridge.handleControl(controlRequest('/refresh', 'POST', signedHeaders('refresh')));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ state_version: 2, revalidated: ['/'] });
    expect(revalidated).toEqual([['/']]);

    // A refresh with no slot changes never invokes the hook.
    engine.setState(3, { robots: 'User-agent: *\n', slots: { 'content/home-hero': '<p>v2</p>', 'meta/how-it-works': { title: 'A' } } });
    await bridge.handleControl(controlRequest('/refresh', 'POST', signedHeaders('refresh')));
    expect(revalidated).toHaveLength(1);
  });

  it('a THROWING revalidation hook is reported, never thrown — the refresh itself still succeeds', async () => {
    const engine = stubEngine(1, { slots: {} });
    const bridge = createBridge({
      engineUrl: 'https://e', siteKey: TEST_SITE_KEY, fetchFn: engine.fetchFn, slots: SLOTS,
      onSlotsChanged: () => { throw new Error('revalidatePath exploded'); },
    });
    await bridge.state!.refreshNow();
    engine.setState(2, { slots: { 'content/home-hero': '<p>new</p>' } });
    const res = await bridge.handleControl(controlRequest('/refresh', 'POST', signedHeaders('refresh')));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ state_version: 2, revalidate_error: 'revalidatePath exploded' });
  });
});
