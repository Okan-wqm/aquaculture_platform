# npm production audit red on GHSA-vcc3-ghjq-m6fr — every PR merge gate blocked

**Date:** 2026-09-01 · **Agent:** zcode · **Cycle:** 2026-09-01 advisory-gate-recovery
**Finding:** SUPPLY-MEDIUM-004 · **State:** OPEN → closed by this change

## What broke

Every open PR's `security-scan` and `security-audit` checks went red between
2026-08-31 evening and 2026-09-01 morning with zero relevant code changes on
the branches. `merge-gate` aggregates `security-audit`, so all merges stopped —
including the ARIA state-continuity fixes, leaving the autonomous lanes dead
(`aria-agent-executor` 5 consecutive failures, `aria-auto-cycle` stalled).

```text
decode-uri-component  <=0.4.2   moderate  DoS via exponential decoding
  query-string  5.0.0 - 9.4.1
    minio  >=7.0.30            (we lock 8.0.7 — the latest release)
```

`npm audit --audit-level=moderate --omit=dev` exits 1 on the root production
graph, which is the first status the gate script propagates.

## Root cause

A newly published advisory (GHSA-vcc3-ghjq-m6fr) turned the unchanged
lockfile red — the same external-advisory-database failure class as
SUPPLY-HIGH-001 (2026-07-26). No code change caused it and no code change can
avoid it: the vulnerable `decode-uri-component@0.2.2` reaches the production
graph only as `minio@8.0.7 → query-string@7.1.3 → decode-uri-component@0.2.2`,
and every exit is blocked upstream:

- `minio@8.0.7` is the newest release and pins `query-string@^7.1.3`.
- `query-string@9.5.0` (the fixed line) is ESM-only (`"type": "module"`); minio
  is CommonJS and `require()`s query-string — an override to 9.x breaks minio
  at module load.
- `decode-uri-component@0.5.0` (the patched release) changed its CJS export
  shape to `{ __esModule, default }` — not callable — so a bare override
  breaks `query-string.parse`.

## Why the override is safe here

The entire production graph contains exactly one consumer chain (verified in
`package-lock.json`: one dependent for each hop):

- minio calls `querystring.stringify(userTags)` once, to build the
  `X-Amz-Tagging` header (`minio/dist/main/helpers.js:132`). It never parses.
- `query-string` invokes `decode-uri-component` only inside its parser
  (`decode()`, used by `parse`/`parseUrl`). `stringify` is encode-side only.

Runtime proof with the override materialized (`decode-uri-component@0.5.0
overridden` under query-string@7.1.3):

```text
stringify (minio path): tag1=de%C4%9Fer%20x&tag2=a%2Fb%26c%3D%3Fd   ✓
parse: TypeError: decodeComponent is not a function                (latent, unused)
```

So the floor override `decode-uri-component: ^0.5.0` clears the audit and
leaves minio's only code path byte-identical in behavior. The latent
`parse` break is contained to a package with a single consumer that never
calls it.

## The fix

`package.json` `overrides` gains `"decode-uri-component": "^0.5.0"`, the same
dependency-floor remedy this repository already uses for upstream-blocked
transitives (brace-expansion, postcss, fast-uri — see SUPPLY-HIGH-001).
Drop the override when minio ships a release depending on query-string ≥ 9.4.2.
