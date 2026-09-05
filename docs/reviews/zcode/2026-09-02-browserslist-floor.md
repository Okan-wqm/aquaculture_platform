# Browserslist HIGH advisories block main's security-audit — dependency floor

**Date:** 2026-09-02 · **Agent:** zcode · **Cycle:** 2026-09-01 advisory-gate-recovery
**Finding:** SUPPLY-HIGH-005 · **State:** OPEN → closed by this change

## What broke

The morning after PR #1390 merged, main's `security-audit` went red on the
aquamobil full audit (`--audit-level=high`) with two newly published
advisories against `browserslist <=4.28.6`:

- **GHSA-c83g-rgw3-j3cx** — unbounded memory growth via distinct query
  results (eventual OOM)
- **GHSA-73wf-gq98-2v4g** — uncaught crash / prototype write via untrusted
  `browserslist-stats.json` custom stats

The unchanged lockfile carried `browserslist@4.28.2`, reaching the aquamobil
workspace transitively through the babel chain
(`@vitejs/plugin-react → @babel/core → @babel/helper-compilation-targets`).
The same external-advisory-DB failure class as SUPPLY-MEDIUM-004
(decode-uri-component): no code change caused it.

## The fix

The workspace's existing `overrides` block (which already floors esbuild,
nanoid, protobufjs and friends for the same reason) gains
`"browserslist": "^4.28.8"` — the same dependency-floor remedy this
repository uses for upstream-blocked transitives. The standalone aquamobil
lockfile had to be regenerated fresh (`npm install --package-lock-only`) to
materialize the resolution: incremental refreshes left the hoisted 4.28.2
in place. Verified locally: both aquamobil audits (full and production)
exit 0 at 4.28.8.

Drop the override when the transitive chains carry `>=4.28.8` natively.
