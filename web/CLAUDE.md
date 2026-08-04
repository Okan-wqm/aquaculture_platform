# web/ — CLAUDE.md (frontend / Module Federation)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY web-frontend facts. It covers `web/shell`, `web/shared-ui`, and `web/modules/*`. (`web/apps/aquamobil` is a standalone PWA with its own `CLAUDE.md`.)

Module Federation via `@module-federation/vite`. `web/shell` is the host; the <!-- cardinality:federated-remotes -->8<!-- /cardinality --> federated remotes live under `web/modules/*` (dashboard, farm-module, sensor-module, hr-module, admin-panel, tenant-admin, hydroponics-module, messaging-module). Remote base: dev `http://localhost:8080/mf`, prod `/remotes` (`web/shell/vite.config.ts`).

## Invariants
- **Shared-deps SSoT:** `web/shared-ui/src/federation/federationSharedConfig.ts` — every shared dep is `singleton: true` + `strictVersion: true` (FE-HIGH-004: two React instances break hooks/context/QueryClient/auth). NEVER inline a `shared:` block in a `vite.config.ts`; import the config. Guarded by `tests/invariants/federation-shared-singleton.spec.ts` + `tests/invariants/web-shared-ui-singleton-imports.spec.ts`.
- **Remote integrity (SH-SEC-04):** `web/shell/src/utils/remoteIntegrity.ts` verifies remote bundles against a build-time-generated SRI manifest (gitignored, emitted under the shell's `src/generated` build dir).
- **Data fetch:** the cross-module pattern is TanStack Query + the tenant-scoped key factory `createTenantQueryKey` (`web/shared-ui/src/utils/tenant-query-keys.ts`) — ALWAYS prefix query keys with `['tenant', tenantId, …]` (FE-CRITICAL-014/015/016: cross-tenant cache leak otherwise). ADR-009/010 describe the admin-panel's legacy `useAsyncData` + styling pattern — they are admin-panel-scoped, NOT the web-wide rule.

## Enforcement
`tests/invariants/federation-shared-singleton.spec.ts`, `tests/invariants/web-shared-ui-singleton-imports.spec.ts`.
