# Tenant Panel Stabilization — Verified Findings (Review of Record)

**Date:** 2026-06-26
**Scope:** Verification of the "Tenant Panel Stabilizasyon v4" claim set against main-branch code (5 parallel domain agents, file:line evidence), then architectural remediation.
**Plan:** `/root/.claude/plans/encapsulated-foraging-lighthouse.md`
**ID format:** initiative labels `TENANTPANEL-{SEVERITY}-{NNN}` below; each finding is assigned a domain-prefixed registry ID (`MT`/`FE`/`FARM`/…) in `docs/reviews/_registry/findings.jsonl` when it enters IN-PROGRESS. Registry IDs are noted inline.
**State machine:** `OPEN` → `IN-PROGRESS` → `RESOLVED` (merged commit carries `Closes:`).

---

## Confirmed findings (real — remediated)

### TENANTPANEL-CRITICAL-001 — SCADA cross-tenant live-data residency
**Registry ID:** `MT-CRITICAL-052` · **Severity:** CRITICAL · **Status:** IN-PROGRESS (PR-B1)
**Files:** `web/modules/sensor-module/src/hooks/useScadaLiveData.ts`,
`web/modules/sensor-module/src/providers/{LiveDeviceDataProvider,HybridDataProvider}.tsx`,
`web/modules/sensor-module/src/services/ScadaSocketService.ts`

**Problem:** SCADA live value/alarm maps were keyed by bare `deviceCode`/`tagId`; effect deps omitted tenant; no tenant-change/logout purge. With a SCADA view mounted across a tenant switch (SUPER_ADMIN impersonation) and an overlapping `deviceCode`/`tagId`, tenant A's live values render in tenant B's view. Sibling hooks (`useSensorSocket`, `useEdgeIoSocket`) already use `${tenantId}:${id}` keys + `onTenantChange` purge — the SCADA path did not. The `/scada` singleton had no tenant-change/logout teardown, so it would keep streaming the previous tenant.

**Fix:** Tenant-partition the `useScadaLiveData` value/alarm maps (`${tenantId}:${deviceCode}`), project back to the bare-key public contract, add `currentTenantId` to the subscription-effect deps, and purge the departed tenant on `onTenantChange` + wipe on logout. Purge the `/scada` provider tag caches on tenant change/logout. Disconnect the `ScadaSocketService` singleton on tenant change/logout so the previous tenant's TAG_VALUES stream stops (fail-safe to no-data, never stale-data). Session-ready reconnect gating + socket-pool refcount correctness + bounded backoff land in TENANTPANEL-HIGH-006 (socket-lifecycle).

**Tests:** `useScadaLiveData.tenant-isolation.test.ts` (4) + `ScadaSocketService.tenant-isolation.test.ts` (3).

### TENANTPANEL-HIGH-002 — Frontend session is token-only, not tenant-verified
**Severity:** HIGH · **Status:** OPEN (PR-A)
Session state fragmented across `tokenLifecycle` + `api-client` module vars + 3 `window.__AQUACULTURE_*` bridges + `AuthContext` + `TenantContext`; the ready barrier resolves on token alone (`token-lifecycle.ts:275`) before `me`/refresh verifies the tenant; no `sessionEpoch`; `createTenantQueryKey` lacks an epoch dimension; bare query keys exist (`tenant-admin`); a nested `QueryClientProvider` (hr-module `./Module`) bypasses the shell's tenant-scoped logout `clear()`; raw `fetch('/graphql'|'/api')` in shell pre-auth + farm uploads. **Fix:** unify into a tenant-verified `SessionSnapshot` + `useTenantQuery`/`useTenantMutation` SSoT hook.

### TENANTPANEL-HIGH-003 — Focus/reconnect refetch ungated by health
**Severity:** HIGH · **Status:** OPEN (PR-A)
`shell/bootstrap.tsx:117-118` enables `refetchOnWindowFocus`/`refetchOnReconnect` with no gate; retry re-hits 502/503/504 (`:54`). A 502/refused window compounds into a refetch storm. **Fix:** wire `onlineManager` to real backend reachability; gate window-focus refetch on session-ready; retain last-good data on transient error.

### TENANTPANEL-HIGH-004 — Tenant status not verified before assertion mint (normal-user path)
**Severity:** HIGH · **Status:** OPEN (PR-C)
`EffectiveTenantMiddleware` validates tenant-ACTIVE for SUPER_ADMIN act-as (`effective-tenant.middleware.ts:170`) but the normal-user branch (`:140-153`) sets `effectiveTenantId = user.tenantId` with no status check, and `/graphql` is in `TENANT_PUBLIC_PATHS` so the status gate is skipped. A tenant suspended after token issuance keeps GraphQL access until token TTL. **Fix:** extend the existing authority validation to the normal-user path, fail-closed in prod, with a short-TTL lookup cache.

### TENANTPANEL-HIGH-005 — Species list silently truncated at 20
**Severity:** HIGH · **Status:** OPEN (PR-D)
`list-species.handler.ts:25` + `species-filter.dto.ts:70` default `limit=20`; `SpeciesTab.tsx:138` passes no pagination and discards `hasNextPage/totalPages`. Rows beyond #20 are unreachable. **Fix:** server-driven pagination as a first-class UI contract + list-visibility invariant.

### TENANTPANEL-HIGH-006 — `/scada` + `/sensors` socket lifecycle hygiene
**Severity:** HIGH · **Status:** OPEN (PR-B2)
`socketFactory.releaseSocket` reads `getTenantId()` at call time → after a switch it releases the new tenant's pool key and leaks the old tenant's socket; no `onTenantChange` teardown for the pool; `/scada` connects token-only; `ScadaSocketService` uses `reconnectionAttempts: Infinity`. **Fix:** tenant-bound refcount, pool teardown on switch, session-ready connect gating, bounded backoff. (CRITICAL-001 lands the residency-critical subset of the `/scada` teardown first.)

### TENANTPANEL-MEDIUM-007 — Departments false "no site" via second query
**Severity:** MEDIUM · **Status:** OPEN (PR-D)
`DepartmentsTab.tsx:341-362` joins a second `useSiteList()` for the site name though `dept.site{ id name }` is already fetched (`useDepartments.ts:69`). **Fix:** render `dept.site.name`.

### TENANTPANEL-MEDIUM-008 — `equipment_types` mixed contract + cross-tenant cache
**Severity:** MEDIUM · **Status:** OPEN (PR-D)
Per-tenant clone + global `@SkipTenantGuard` read + filter-only (tenant-blind) in-process cache (`get-equipment-types.handler.ts:47`) serve the first tenant's result to all. **Decision:** per-tenant catalog (consistent with the reference-data-clone pattern). **Fix:** tenant-scoped read + `${tenantId}:` cache key + reconcile the stale catalog-checker doc.

### TENANTPANEL-MEDIUM-009 — No post-provision hard gate
**Severity:** MEDIUM · **Status:** OPEN (PR-D)
`validateTenantSchemaComplete` runs only on the re-provision branch and asserts the migration ledger, not seed/reference-row counts or row placement. **Fix:** post-provision verification of reference-data counts + row placement.

### TENANTPANEL-LOW-010 — Enforcement gaps + PR-time E2E
**Severity:** LOW · **Status:** OPEN (PR-E)
Missing gates: raw-fetch ban, module-local GraphQL client ban, nested QueryClientProvider ban, tenant-inert socket store ban, middleware-matrix invariant, non-HTTP `withTenantContext` invariant; tenant A/B E2E is post-deploy, not on the PR gate. **Fix:** add the gates; promote + extend the E2E into the PR gate; escalate `no-bare-tenant-query-key` to error.

---

## Refuted claims — NO code change (recorded to prevent re-opening)

- **Refresh-token cookie encode/decode bug** — already correct: `refresh-token-cookie.ts:45` identity encoder + defensive `decodeRefreshTokenTransport`.
- **"assertion-first + legacy x-user-payload fallback in prod"** — already assertion-only in prod (`verified-user-assertion.middleware.ts:33-37`; `StripInternalHeadersMiddleware` strips `x-user-payload`).
- **`tenantId || 'default'` in query keys/requests** — does not exist (only a test helper).
- **Module-local GraphQL clients in remotes** — remotes delegate to the shared `graphqlClient`.
- **"token-only sockets / nothing cleared on switch / socket→GraphQL query storm"** — farm + sensor sockets gate on tenant+token; sensor/edge stores clear on `onTenantChange`; no socket→GraphQL storm exists. Only the `/scada` sub-claims were real (CRITICAL-001 / HIGH-006).
- **"mutation rows invisible until manual reload"** — every mutation calls `invalidateQueries`, which auto-refetches the mounted list. (Read-after-write robustness is still standardized under PR-A/PR-D.)
- **Gateway ALS seed order / SUPER_ADMIN no-tenant** — literal observations true but fail-closed downstream (RLS + base schema + `TenantIsolationGuard`); hardened as defense-in-depth invariants under PR-C, no behavioral defect.
