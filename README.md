# @signalto/bridge-node

SignalTo's content-bridge connector for Node.js apps. Once mounted and paired, SignalTo
can manage this site's `robots.txt`, root files (`llms.txt`, `.well-known/*`), redirects,
and response headers — and, where you wire slots, page titles/descriptions, JSON-LD, and
designated content regions — previewed, applied, verified, and instantly rollback-able
from SignalTo, with no deploys.

## Setup

**Requirements:** Node.js **18.17 or newer**, and an **ESM** project. The package ships
ES modules only — there is no CommonJS build, so `require('@signalto/bridge-node')` will
not work. In a CommonJS codebase, load it with a dynamic `await import(...)`.

Set the two environment variables from your SignalTo link instructions:

```
SIGNALTO_SITE_KEY=sk_...        # shown once when the site is linked
SIGNALTO_SITE_URL=https://your-domain.com
```

Mount the adapter for your framework **first** — before routes and other middleware —
then deploy. On boot the connector confirms the pairing automatically — no pairing
code: the key itself is the proof, and re-confirming is a harmless no-op on every
later boot (it also self-heals a re-link on your next deploy).

Pointing at a staging or self-hosted SignalTo engine? Set `SIGNALTO_ENGINE_URL` —
production uses the built-in default and never needs it.

### Express / Connect

```js
import { signaltoBridge } from '@signalto/bridge-node/express';
app.use(signaltoBridge());
```

### Fastify

```js
import { signaltoFastify } from '@signalto/bridge-node/fastify';
await app.register(signaltoFastify());
```

### Koa

```js
import { signaltoKoa } from '@signalto/bridge-node/koa';
app.use(signaltoKoa());
```

### Next.js (App Router)

Three files — Next splits across two runtimes and the bridge respects that:

```ts
// lib/signalto.ts — one bridge per runtime, shared config
import { createBridge } from '@signalto/bridge-node';
export const bridge = createBridge({
  controlPath: '/api/signalto',   // App Router can't route underscore dirs
  slots: [
    { opType: 'meta', name: 'how-it-works', path: '/how-it-works', mode: 'static' },
  ],
});
```

```ts
// middleware.ts — the serving layer (robots/root files/redirects/headers)
import { NextResponse } from 'next/server';
import { signaltoNextMiddleware } from '@signalto/bridge-node/next';
import { bridge } from './lib/signalto';
const handle = signaltoNextMiddleware(bridge);
export async function middleware(req: Request) {
  return handle(req, () => NextResponse.next());
}
export const config = {
  matcher: ['/robots.txt', '/llms.txt', '/llms-full.txt', '/.well-known/:path*'],
  // Broaden only if you want site-wide redirects/headers — middleware
  // invocations are billed per request on Vercel. SignalTo's capability
  // report reflects whatever scope you choose; it never overpromises.
};
```

```ts
// app/api/signalto/[...op]/route.ts — the control surface (Node runtime;
// wiring revalidatePath here is what lets slot changes appear on
// static/ISR pages without a redeploy)
import { revalidatePath } from 'next/cache';
import { signaltoNextRouteHandlers } from '@signalto/bridge-node/next';
import { bridge } from '@/lib/signalto';
export const { GET, POST } = signaltoNextRouteHandlers(bridge, { revalidatePath });
```

Slot helpers in pages:

```ts
import { signaltoMeta, signaltoContent } from '@signalto/bridge-node/next';
import { bridge } from '@/lib/signalto';

export async function generateMetadata() {
  return signaltoMeta(bridge, 'how-it-works', { title: 'How it works', description: '…' });
}
// In a server component:
const note = await signaltoContent(bridge, 'how-it-works-note', '');
```

### Hono (and the WinterCG fetch family)

```js
import { createBridge } from '@signalto/bridge-node';
import { createFetchHandler } from '@signalto/bridge-node/fetch';

const bridge = createBridge();
const handle = createFetchHandler(bridge);
app.use('*', async (c, next) => {
  const res = await handle(c.req.raw, async () => { await next(); return c.res; });
  if (res && res !== c.res) {
    c.res = undefined;  // Hono merges old headers on assignment — reset first
    c.res = res;
  }
});
```

**Remix** (`entry.server` or a root loader wrapper), **SvelteKit** (`hooks.server.ts`
`handle`), **Astro SSR** (middleware `onRequest`), **Nuxt/h3** (server middleware):
the same `createFetchHandler(bridge)` — call it with the incoming `Request` first;
a returned `Response` is the answer, `undefined` means continue; pass a `next`
callback that yields your framework's response so managed headers apply:

```js
// SvelteKit hooks.server.ts
const bridgeHandle = createFetchHandler(bridge);
export async function handle({ event, resolve }) {
  return (await bridgeHandle(event.request, () => resolve(event))) ?? resolve(event);
}
```

### Nuxt

A server middleware wrapping the canonical node handler, registered first
(tested against h3 v1, today's Nuxt engine, AND the h3 v2 release candidate):

```js
// server/middleware/00.signalto.ts
import { fromNodeMiddleware } from 'h3';
import { createBridge } from '@signalto/bridge-node';
import { createNodeHandler } from '@signalto/bridge-node/node';
export default fromNodeMiddleware(createNodeHandler(createBridge()));
```

### hapi

```js
import { createBridge } from '@signalto/bridge-node';
import { createNodeHandler } from '@signalto/bridge-node/node';

const handler = createNodeHandler(createBridge());
server.ext('onRequest', (request, h) => new Promise((resolve) => {
  const { req, res } = request.raw;
  res.once('finish', () => resolve(h.abandon)); // the bridge answered
  handler(req, res, () => resolve(h.continue)); // pass through to hapi
}));
```

### Anything else (Sails, custom `http` servers)

The canonical `(req, res, next)` handler from `@signalto/bridge-node/node` mounts
anywhere Node middleware fits — it runs standalone on a bare `node:http` server too.

## Wiring slots (meta / schema / content)

Declare each editable region in the bridge options — what's declared (and reflectable)
is exactly what SignalTo may edit, nothing else:

```js
slots: [
  { opType: 'meta',    name: 'how-it-works', path: '/how-it-works', mode: 'static' },
  { opType: 'schema',  name: 'org',          path: '/',             mode: 'dynamic' },
  { opType: 'content', name: 'home-hero',    path: '/',             mode: 'isr' },
]
```

`mode` is how the route renders: `dynamic` (per-request), `isr` (revalidatable), or
`static` (build-time). Static routes are editable only when a revalidation hook is
wired (Next: `revalidatePath` above) — otherwise SignalTo reports them honestly as
not-yet-editable rather than applying changes that couldn't appear until a redeploy.
Read values with `bridge.slot(opType, name, fallback)` (sync) or
`bridge.slotAsync(...)` (cold-start-tolerant, capped wait).

## Auto-head (opt-in): managed titles without wiring

```js
createBridge({ autoHead: true })
```

On pages SignalTo holds a managed head for, the connector rewrites ONLY the
`<title>`, description, canonical, and JSON-LD in the live response as it streams
through — the app stays the source of truth for everything else, every request,
and revert simply stops the transform. Field groups move together (a managed
title updates `og:title`/`twitter:title` with it), revalidation is owned by the
bridge (a browser can never 304 its way to a stale title), and injected JSON-LD
carries the page's CSP nonce when one exists.

**Where it works — decided by the served HTML, not the framework:**

| Served HTML | Auto-head |
|---|---|
| Server-template SSR (Express/Connect, Fastify, Koa, hapi/h3 rendering HTML) | ✅ |
| Astro SSR | ✅ — islands hydrate components, never the document head |
| React-hydrated pages (Next.js, Remix, any React SSR), Nuxt, and SvelteKit | ❌ refused by name (`react_hydration_owns_head`) — client hydration re-owns the head, so JS-rendering crawlers would see the app values; use slots / the `wire` command instead |

On Fastify and Koa the transform runs on the buffered response (`onSend` / `ctx.body`).
A route that hands those frameworks a *stream* instead of a string or Buffer is passed
through untouched and reported in health — Express/Connect and the fetch handler
transform streamed HTML as it flows.

## Wire existing Next.js pages in one command

```
npx signalto-bridge wire [--dir app] [--bridge-import @/lib/signalto] [--dry-run]
```

Transforms every page whose `export const metadata = {…}` is a provable literal
into slot-wired `generateMetadata` — the literal becomes the fallback (and the
rollback target), share-card fields follow the managed values, and the command
prints the slots-manifest snippet to paste into your bridge config. Anything
non-literal (imported, computed, dynamic routes) is a reported skip with the
manual recipe — the codemod never guesses, and the diff is yours to review and
commit. Fully idempotent.

## The contract with your app

- **Mount order matters**: mounted late, the connector never sees `/robots.txt` —
  nothing breaks, but SignalTo will honestly report those capabilities unavailable.
- **Zero added latency on unmanaged requests**: the request path does a couple of Map
  lookups; all engine communication happens in the background (`npm run bench` in
  this package measures it — the overhead sits below local-HTTP noise).
- **Your site never depends on SignalTo's availability**: if the engine is
  unreachable the connector serves its last-known state; with no state at all it
  passes every request through untouched.
- **It cannot touch security headers**: `Set-Cookie`, CSP, HSTS, CORS and friends are
  denylisted inside the connector itself — even a misbehaving engine cannot change
  them through us.
- **It never reads request bodies, and never breaks on its own bugs**: any internal
  error passes the request through untouched.
- **It rewrites HTML only where you opted in**: with `autoHead` off (the default) no
  response body is ever read or altered. With it on, only pages SignalTo holds a
  managed head for are touched, only their `<head>` is rewritten, and the rest of the
  document streams through byte-for-byte. Anything that fails the gate — a non-200, a
  non-HTML or non-UTF-8 response, an already-compressed body, a client-hydrated head,
  a `<head>` over 64 KB — is served exactly as your app produced it.

## Front proxies and CDNs

The engine's capability probes are end-to-end against your live URLs. If a reverse
proxy or CDN serves `/robots.txt` directly (or caches managed paths hard), SignalTo
reports those paths as shadowed instead of pretending to manage them — add a
cache-bypass or pass-through rule for `robots.txt`, `llms.txt`, `.well-known/*` and
re-check. Changes propagate within the connector's pull TTL (default 60s) plus any
CDN window; SignalTo's verification allows for exactly that.

## What it won't do

The bridge is deliberately narrow. Everything below is a hard boundary — SignalTo
reports these honestly rather than working around them, so nothing here fails
silently.

**Your code stays yours**
- No arbitrary page edits: copy, components, navigation, layout, and styling live
  in your repo. The editable surface is explicit: wired slots — plus, only when
  you opt in to auto-head, the head fields (title/description/canonical/JSON-LD)
  of non-client-hydrated pages. The capability report says exactly which pages
  fall on which side.
- No new pages or routes — a Node app's routes are code; the bridge never creates
  them.
- No writes to your repository: no commits, no PRs, no template or config edits.

**Hard boundaries by design**
- Security headers are untouchable — `Set-Cookie`, CSP, HSTS, CORS and the rest are
  refused inside the connector itself, in both directions (set and remove).
- Root files are allowlisted (`robots.txt`, `llms.txt`, `security.txt`,
  `.well-known/*`) — never `index.html`, never `/api/*`, never an arbitrary path.
- No HTML rewriting beyond the `<head>`, and none at all unless you set
  `autoHead: true`. Even then the bridge parses only up to `</head>`, replaces only
  the title/description/canonical/JSON-LD fields SignalTo manages for that page, and
  never parses or touches the body.
- One connection, one domain: multi-tenant apps (one process, many customer domains)
  aren't supported, and apps mounted under a sub-path can't serve domain-root files.

**Environment limits**
- No server runtime, no bridge: static-export/SSG-only builds connect through
  SignalTo's edge platform instead.
- A front proxy or CDN that serves a managed path directly outranks the bridge —
  SignalTo reports the path as shadowed instead of pretending to manage it (add a
  pass-through rule, then re-check).
- A slot on a build-time-rendered route is editable only once a revalidation hook is
  wired (Next: `revalidatePath`) — otherwise it's reported as not-yet-editable,
  never silently stale.
- Auto-head refuses React-hydrated and SvelteKit pages BY NAME — client hydration
  re-owns the head there, and a transform Googlebot can't see would be dishonest.
  Those pages use slots / the `wire` command.
- Changes propagate within the pull interval (default 60s) plus any CDN caching —
  this is not an instant-purge CDN, and verification allows for exactly that window.
- `sitemap.xml` stays app-owned in this version.
