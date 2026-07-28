# aquamobil — CLAUDE.md (standalone offline-first PWA)

> Root rules in `/CLAUDE.md` apply; `web/CLAUDE.md` (Module Federation) does NOT — aquamobil is a STANDALONE Vite app, not a federated remote. This file is its authority.

Field-worker mobile data-entry PWA. `base: '/mobile/'`, own toolchain + standalone lockfile + own `node_modules` (Docker build context is `web/apps/aquamobil/`), dev port 8090 (`web/apps/aquamobil/vite.config.ts`). Konsta UI; React 19.

## Invariants
- **PWA service worker:** `vite-plugin-pwa` in `injectManifest` mode — the DEPLOYED SW is the HAND-WRITTEN `web/apps/aquamobil/src/pwa/messaging-sw.ts` (FE-CRITICAL-050-SW). It owns offline sync, `notificationclick`, and LOGOUT handlers plus the precache manifest. Do NOT switch to `generateSW` (it drops those handlers).
- **Tenant query keys are DUPLICATED — keep in sync:** aquamobil does NOT import `@aquaculture/shared-ui`, so `createTenantQueryKey` is a verbatim copy at `web/apps/aquamobil/src/utils/tenant-query-keys.ts`. Any change to the shared-ui factory MUST be mirrored here (and vice-versa). The tenant-prefix invariant is identical (FE-CRITICAL-014/015/016).
- **React dedupe:** `libs/farm-shared` is aliased (not npm-installed); `vite.config.ts` sets `dedupe: ['react','react-dom']` to force a single React copy across the aliased boundary (Tier-1 "make it impossible").

## Enforcement
The S1 codegen gate covers its GraphQL client. The vitest suite (66 files / 383 tests) runs per PR through the inferred **`test`** target — Nx infers this project's targets from `package.json` scripts, so until a plain `test` script existed the whole suite was unselectable and ran nowhere (FARM-MEDIUM-304); `test:invariant` covers the SW build artifact separately. Both are kept reachable by `tests/invariants/test-target-ci-reachability.spec.ts`. NOTE: the `eslint src` lint baseline is large and pre-existing (ORPHAN-MEDIUM-112) — do not treat it as a clean gate.
<!-- back-test: CLAUDE-DRIFT-007, verified 2026-06-16 -->
