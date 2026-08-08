# aquamobil — CLAUDE.md (standalone offline-first PWA)

> Root rules in `/CLAUDE.md` apply; `web/CLAUDE.md` (Module Federation) does NOT — aquamobil is a STANDALONE Vite app, not a federated remote. This file is its authority.

Field-worker mobile data-entry PWA. `base: '/mobile/'`, own toolchain + standalone lockfile + own `node_modules`, dev port 8090 (`web/apps/aquamobil/vite.config.ts`). Konsta UI; React 19. The Docker build context is the REPO ROOT, not the app dir — `infrastructure/docker/Dockerfile.aquamobil` copies `libs/farm-shared` and `libs/shared-contracts` from outside the app; only the builder WORKDIR and the lockfile install are app-scoped.

## Invariants
- **PWA service worker:** `vite-plugin-pwa` in `injectManifest` mode — the DEPLOYED SW is the HAND-WRITTEN `web/apps/aquamobil/src/pwa/messaging-sw.ts` (FE-CRITICAL-050-SW). It owns offline sync, `notificationclick`, and LOGOUT handlers plus the precache manifest. Do NOT switch to `generateSW` (it drops those handlers).
- **Tenant query keys are a MIRROR that has already DRIFTED:** aquamobil does not import `@aquaculture/shared-ui` (deliberate — standalone lockfile, offline-first), so `createTenantQueryKey` is hand-maintained at `web/apps/aquamobil/src/utils/tenant-query-keys.ts`. The tenant-prefix contract `['tenant', tenantId, …]` DOES hold in both, so there is no cross-tenant leak (FE-CRITICAL-014/015/016). The two are NOT identical: `web/shared-ui/src/utils/tenant-query-keys.ts` appends `sessionEpochSegment()` (#687, ORPHAN-MEDIUM-200 — fresh cache on tenant re-entry) and the aquamobil mirror has no epoch segment, so it still serves stale cache after tenant re-entry. That gap is open; the file's own "Mirrors … verbatim" header comment is wrong too. Do not trust either file's claim of equality — diff them.
- **React dedupe:** `libs/farm-shared` is aliased (not npm-installed); `vite.config.ts` sets `dedupe: ['react','react-dom']` to force a single React copy across the aliased boundary (Tier-1 "make it impossible").

## Enforcement
The S1 codegen gate covers its GraphQL client. NOTE: the `eslint src` lint baseline is large and pre-existing (ORPHAN-MEDIUM-112) — do not treat it as a clean gate.
