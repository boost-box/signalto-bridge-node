# Contributing

**This repository is a read-only mirror.** It exists so that
[`@signalto/bridge-node`](https://www.npmjs.com/package/@signalto/bridge-node) can be
published to npm with [provenance
attestation](https://docs.npmjs.com/generating-provenance-statements) — npm requires the
repository named in `package.json` to be public and to match the repository the release
is published from.

The connector's source of truth lives in SignalTo's private engine monorepo. Each release
is synced here as a single commit and tagged, so the code you see is exactly what was
published.

## Pull requests are not accepted here

A PR merged into this mirror would be silently overwritten by the next sync. We're not
being unfriendly — there is genuinely nowhere for the change to live.

## Found a bug, or want a framework adapter?

- **Bugs and security reports:** support@signalto.ai. For anything security-sensitive,
  please report privately rather than opening a public issue.
- **Feature and adapter requests:** support@signalto.ai, or through your SignalTo account
  contact.

Include the connector version (`npm ls @signalto/bridge-node`), your Node version, and
the framework and version you're mounting it in — the adapter surface is where nearly all
real-world differences show up.

## Verifying a release

Every published version carries a provenance attestation linking the tarball to the
commit and workflow run that built it:

```bash
npm audit signatures
```

The connector has **zero runtime dependencies** by design — `npm ls --omit=dev` on an
install should show nothing beneath it.
