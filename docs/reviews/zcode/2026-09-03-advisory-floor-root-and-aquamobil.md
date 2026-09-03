# Root production and AquaMobil audits red again — four more advisory floors

**Date:** 2026-09-03 · **Agent:** supply-chain-auditor · **Cycle:** 2026-09-03
branch-evaluation-merge · **Finding:** SUPPLY-HIGH-006 · **State:** OPEN → closed by this
change

## What broke

Bringing `fix/browserslist-floor` (PR #1391, SUPPLY-HIGH-005) onto the evaluation
branch and re-running the same audit commands `ci-affected.yml` runs showed the gate
is red beyond the one advisory that PR floored:

| Surface                      | Package         | Advisory range   | Path                                               |
| ---------------------------- | --------------- | ---------------- | -------------------------------------------------- |
| root `--omit=dev` (moderate) | `browserslist`  | `<=4.28.6`       | `vite-plugin-svgr → @svgr/core → @babel/core`      |
| root `--omit=dev` (moderate) | `fast-uri`      | `3.0.0 - 3.1.5`  | `ajv` (override already floored at `^3.1.5`)       |
| root `--omit=dev` (moderate) | `qs`            | `2.2.5 - 6.15.3` | `@apollo/server → body-parser`, `express@5`        |
| root `--omit=dev` (moderate) | `sanitize-html` | `1.9.0 - 2.17.6` | direct dependency at `^2.17.4`                     |
| aquamobil full (high)        | `fast-uri`      | `3.0.0 - 3.1.5`  | `ajv`, pinned by the workspace override at `3.1.5` |

Same class as SUPPLY-MEDIUM-004 and SUPPLY-HIGH-005: no code change caused it; the
advisory database moved under an unchanged lockfile.

## The fix

- Root `overrides`: `browserslist ^4.28.8`, `fast-uri ^3.1.6`, `qs ^6.15.4`; the direct
  `sanitize-html` dependency moves to `^2.17.7` (a direct dependency is bumped, not
  overridden).
- AquaMobil override `fast-uri 3.1.5 → 3.1.6` (the e2e workspace floor already sat at
  `3.1.6`; the three standalone graphs now agree).
- Both lockfiles regenerated with `npm install --package-lock-only`.
- `tests/invariants/dependency-security-floor.spec.ts` carries the floors: a new root
  production test for the four packages and the AquaMobil block extended with the
  `browserslist` floor from SUPPLY-HIGH-005, so a later lockfile refresh cannot slide
  under them silently.

Drop each override when the transitive chains carry the patched version natively.
