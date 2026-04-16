# Frontend React Audit — 2026-04-W16

**Cycle:** 2026-04-W16 (Part A discovery). **Owner agent:** frontend-expert.
**Scope:** `web/shell/**`, `web/shared-ui/**`, `web/modules/{dashboard,farm-module,sensor-module,hr-module,admin-panel,tenant-admin,hydroponics-module}/**`, `web/apps/aquamobil/**`.
**Mode:** READ-ONLY. No source code was modified. No `npm run` / build commands were invoked.
**Prior review:** `docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md` (FE-CRITICAL-001 remoteEntry bypass — FIXED; FE-CRITICAL-002 tenant-scoped cache prefix — FIXED; FE-HIGH-001 meta CSP `unsafe-inline` on script-src — still present in meta-tag fallback, header-level CSP is authoritative).

---

## Tech anchor reconciliation (IMPORTANT drift vs. the task description)

The task description lists tech as **"React 18.2, Vite 7.3.1, @nx/react + @nx/vite 22.3.3, eslint-plugin-react-hooks 5.0.0"**. Static evidence from `package.json` files contradicts parts of this:

| Anchor | Task claim | Evidence in repo | Files |
|---|---|---|---|
| React runtime pin | 18.2.0 | **18.3.1** in shell/bootstrap, **^18.2.0** in shared-ui peerDep, **^18.2.0** in aquamobil + all remotes | `web/shell/package.json:19`, `web/shared-ui/package.json:35`, `web/apps/aquamobil/package.json:23`, `web/modules/*/package.json` |
| Vite | 7.3.1 | **^5.0.0** in shell / shared-ui / every `web/modules/*/package.json`. **^5.4.0** in aquamobil. 7.3.1 appears only in root `package.json` devDep (orphan — no workspace consumes it). | `web/shell/package.json:34`, `web/apps/aquamobil/package.json:38`, `web/modules/farm-module/package.json:45`, `web/modules/sensor-module/package.json:41` |
| @nx/react / @nx/vite 22.3.3 | assumed | Nx drives `nx:run-commands` executors that delegate to `npm run dev|build` inside each workspace — NOT `@nx/react:application` / `@nx/vite:build` executors. Federation is wired via `@originjs/vite-plugin-federation`, not `@nx/module-federation`. | `web/shell/project.json`, `web/modules/*/project.json` |
| Module Federation plugin | `@nx/module-federation` assumed | `@originjs/vite-plugin-federation` ^1.3.5 (Rspack-style, Vite-native) | every `web/*/vite.config.ts` |
| `eslint-plugin-react-hooks` | 5.0.0 | Mixed: **5.0.0 / ^5.0.0** in modules, **^4.6.0** in `web/shared-ui/package.json:54` | shared-ui out of lockstep |
| `eslint-plugin-react` | ^7.33.2 | ^7.33.0 shared-ui | `web/shared-ui/package.json:53` |

**Finding FE-HIGH-001:** The audit anchors used to drive Part B knowledge updates and Part C skill catalogs must be rewritten around actual pins (React 18.3.1, Vite 5, `@originjs/vite-plugin-federation`), not the aspirational pins in the task prompt. Authoring skills against Vite 7 APIs / React 19 Server Actions would ship dead knowledge.

---

## Table 1 — Pattern usage

| # | Pattern | Usage count | Entry points / examples |
|---|---|---|---|
| 1 | Suspense boundaries (application code, excl. node_modules) | 46 usages across 10 files | `web/shell/src/App.tsx` wraps every remote (15 sites); `web/apps/aquamobil/src/App.tsx` (3 sites); one per module (`tenant-admin/src/Module.tsx`, `hr-module/src/Module.tsx`, `admin-panel/src/Module.tsx`, `sensor-module/src/Module.tsx`) |
| 2 | Error Boundaries wrapping MF remotes | 6 class ErrorBoundary components; 15 `<ErrorBoundary>` wraps in shell/App.tsx around every remote | `web/shell/src/components/ErrorBoundary.tsx`, `web/modules/tenant-admin/src/components/ErrorBoundary.tsx`, `web/modules/hr-module/src/components/scheduling/SchedulingErrorBoundary.tsx`, `web/apps/aquamobil/src/components/ErrorBoundary.tsx` |
| 3 | `useTransition` / `startTransition` | Effectively 0 production call-sites. Only: React Router future flag `v7_startTransition: true` in `ConfiguredBrowserRouter.tsx:27`. No direct `useTransition()` hook usage anywhere. | `web/shared-ui/src/components/ConfiguredBrowserRouter.tsx:27` |
| 4 | `useDeferredValue` | 2 production call-sites | `web/modules/hr-module/src/pages/employees/EmployeesListPage.tsx:42` (search debounce), `web/modules/hydroponics-module/src/hooks/useCalculation.ts:15-16` (PID calc) |
| 5 | React Query queryKey convention | 129 `queryKey:` call-sites across 20 files; factory `createTenantQueryKey()` exists in `shared-ui/utils/tenant-query-keys.ts` but **adopted in only 4 files** (see FE-CRITICAL-002) | `web/shared-ui/src/utils/tenant-query-keys.ts`, `web/modules/dashboard/src/widgets/LiveSensorWidget.tsx:85,99` |
| 6 | `staleTime` / `gcTime` defaults | Per-domain `resolveStaleTime()` callback driven by queryKey prefix; 3 tiers (30s realtime, 120s standard, 600s reference). `gcTime: 30 * 60_000` flat. `cacheTime:` not used anywhere (v5-correct). | `web/shell/src/bootstrap.tsx:87-121` |
| 7 | shared-ui component surface | 37 exported components + 6 hooks + 14 utils + 2 contexts | `web/shared-ui/src/index.ts` (barrel), `web/shared-ui/src/components/` |
| 8 | shared-ui import convention | `import { X } from '@aquaculture/shared-ui'`; shared as singleton+strictVersion per MF config | `web/shared-ui/src/federation/federationSharedConfig.ts:84-89` |
| 9 | GraphQL codegen wiring | `codegen.ts` at repo root generates to `web/shared-ui/src/generated/graphql-types.ts`. **That generated file DOES NOT EXIST on disk, and NO file imports from it.** Pipeline is defined but unused. | `codegen.ts:16`; generated dir not found |
| 10 | PWA service worker | `vite-plugin-pwa` with Workbox runtime caching (NetworkFirst for navigation w/ 5s timeout, CacheFirst for static, StaleWhileRevalidate for images). GraphQL runtime caching intentionally removed (CRIT-2/SEC-02/PERF-01). `skipWaiting: true, clientsClaim: true`. | `web/apps/aquamobil/vite.config.ts:47-128` |
| 11 | Offline queue (AquaMobil) | idb-keyval separate stores; AES-GCM 256 per-session, non-extractable, 12-byte random IV per encrypt; 200 item cap; 5s dedup window; tenant-scoped keys `pending_${tenantId}_${id}` and `cache_${tenantId}:${key}`; exponential backoff (2s base → 5m cap); dead-letter at `MAX_RETRY_COUNT = 5`. | `web/apps/aquamobil/src/pwa/offline-queue.ts:1-459` |
| 12 | MF remote loading flow | Shell imports `installRemoteIntegrityGuard()` FIRST in `main.tsx`, then dynamic `import('./bootstrap')` to defer MF runtime negotiation. Integrity guard patches `Document.prototype.createElement` + `Element.prototype.setAttribute` (both paths). SRI hash pins from `src/generated/remoteHashes.json` (gitignored, CI-populated). Prod fail-closed when pin missing. | `web/shell/src/main.tsx:1-23`, `web/shell/src/utils/remoteIntegrity.ts:1-314` |
| 13 | Single-flight token refresh | Module-scoped `tokenRefreshPromise`, shared by `silentRefresh()` + GraphQL 401 handler + REST 401 handler + `tokenLifecycle` proactive refresh. Retry cap `retryCount === 0`. | `web/shared-ui/src/utils/api-client.ts:128,272-308,577-606` |
| 14 | Token lifecycle state machine | States `INITIALIZING → REFRESHING → READY → EXPIRED`. 80% TTL proactive refresh + `installVisibilityTokenRefresh()` on `visibilitychange`/`focus`. MFE bridge via `window.__AQUACULTURE_AUTH_STATE__` + frozen-getter `window.__AQUACULTURE_AUTH__`. | `web/shared-ui/src/utils/token-lifecycle.ts:22,54-65`, `web/shared-ui/src/utils/api-client.ts:139-157` |
| 15 | Tailwind config propagation | 7 tailwind.config.js (shell + 5 modules + aquamobil/styles via css import). ADR-010 compliance: majority Tailwind, inline `style={{}}` accepted as debt in 13 files. | `web/shell/tailwind.config.js`, `web/modules/*/tailwind.config.js` |

---

## Table 2 — Anti-pattern spots

| # | Pattern | Occurrences | Example file:line | Severity | Fix direction |
|---|---|---|---|---|---|
| 1 | `as any` casts | 89 across 50 files (excl. tests) | `web/modules/admin-panel/src/hooks/useAsyncData.ts:4`, `web/shared-ui/src/utils/api-client.ts` L2 sites | HIGH | Introduce generics; fix interface in `@platform/event-contracts` or shared-ui types |
| 2 | `any` as standalone type | 114 files | `web/modules/sensor-module/src/hooks/useScadaLiveData.ts:2`, widespread in SCADA/Fuxa interop | HIGH | Replace with `unknown` + narrowing; eliminate via generated GraphQL types |
| 3 | `@ts-ignore` / `@ts-expect-error` | 1 occurrence (tolerable) | `web/modules/sensor-module/src/components/automation/st-language.ts:1` | LOW | Verify the justification comment; otherwise fix the type |
| 4 | React Query key NOT prefixed with `['tenant', tenantId, ...]` | Overwhelming majority — only 4 files use `createTenantQueryKey()`, 20+ modules use bare `[domain, tenantId, …]` or `[domain, …]` without the 'tenant' literal | `web/modules/tenant-admin/src/pages/TenantDashboard.tsx:150,172,182`, `web/apps/aquamobil/src/hooks/useLeave.ts:87,144,184`, `web/modules/farm-module/src/hooks/*` (265 queryKey sites in farm-module alone) | **CRITICAL** | Adopt `createTenantQueryKey()` system-wide; add ESLint rule against bare queryKey arrays |
| 5 | `queryClient.invalidateQueries({ queryKey: ['dashboard'] })` — domain-only, tenant-agnostic | ≥8 call-sites | `web/modules/tenant-admin/src/pages/TenantDashboard.tsx:222`, `web/apps/aquamobil/src/hooks/useLeave.ts:234,235,266,267` | HIGH | Invalidate via `['tenant', tenantId, ...domain]` narrowest key |
| 6 | Hand-written GraphQL string literals (no codegen-generated types consumed) | ≥243 `gql`-like template literals across 30+ files | `web/shared-ui/src/contexts/AuthContext.tsx:223-244, 324-344`, every `*.operations.ts` | HIGH | Re-enable codegen output (it currently generates a file no one imports); migrate operations to typed documents |
| 7 | `lazy()` without meaningful Suspense fallback text (accessibility) | `RemoteModuleLoader` in shell OK; AquaMobil uses `<PageLoader>` with silent spinner (no `role="status"` / `aria-live`) | `web/apps/aquamobil/src/App.tsx:124-130` | MEDIUM | Wrap spinner in `role="status" aria-live="polite"` + visually-hidden text |
| 8 | `useEffect` + `setInterval` for polling | 0 production hits (all polling uses `refetchInterval`) | confirmed via grep | — | Good state, keep |
| 9 | Fire-and-forget `useEffect` fetch | 0 production hits | — | — | Good state |
| 10 | `dangerouslySetInnerHTML` | 6 call-sites; **all gated through DOMPurify sanitize-html util or SVG allowlist** | `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CustomSvgRenderer.tsx:78`, `web/modules/tenant-admin/src/pages/TenantAnnouncementsPage.tsx:479` | LOW | Wrap all paths through a single named Trusted Types policy |
| 11 | CSP meta-tag in `index.html` permits external scripts via `cdn.jsdelivr.net` without nonce/`strict-dynamic` | 1 | `web/shell/index.html:17-30` | HIGH | Move authoritative CSP to nginx response header with `strict-dynamic` + per-request nonce; remove meta fallback or make it as strict |
| 12 | React Router v6 Navigate used without focus management on route change | 1 `<RouteAnnouncer />` is in place (FE-HIGH-017) | `web/shared-ui/src/components/a11y/RouteAnnouncer.tsx` | LOW | Verify it both announces and moves focus to `<h1>` / main |
| 13 | `useReducer` for local toggle/disclosure state | 3 files use reducers correctly for AuthContext/TenantContext/hydroponics solution | — | — | Good state |
| 14 | `useState<Record<string, unknown>>` for forms with multiple fields | 12 files use object state | `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx:1`, `web/modules/admin-panel/src/pages/InvoicesPage.tsx:1` | LOW | Candidate for `useReducer` if state transitions exceed 3 |
| 15 | Class ErrorBoundary (React 18 still has no hook equivalent — keep) | 6 | `web/shell/src/components/ErrorBoundary.tsx`, `web/apps/aquamobil/src/components/ErrorBoundary.tsx` | — | Keep until `react-error-boundary` is formally adopted |

---

## Table 3 — Modernization opportunities

| # | Target | Benefit | Effort | Priority |
|---|---|---|---|---|
| M1 | Adopt `createTenantQueryKey()` system-wide; ESLint AST rule banning bare `queryKey:` arrays not starting with `'tenant'` literal | Closes the largest cross-tenant cache-leak surface; enables single-call `invalidateQueries({ queryKey: ['tenant', oldId] })` on tenant switch | medium — `codemod` across 30+ hook files | P0 |
| M2 | Re-wire GraphQL codegen end-to-end: adopt `typed-document-node` + `client-preset`, generate to `web/<scope>/src/generated/`, import generated types at every `graphqlClient.request<T>()` call-site | Eliminates 114 `any` + 89 `as any` sites and the 243 hand-typed query strings; keeps schema drift detectable at CI | large — but the pipeline is already defined in `codegen.ts` and unused | P0 |
| M3 | Introduce `useTransition` around table filter / search inputs in `farm-module`, `admin-panel` list pages (≥12 list pages have client-side filter state with heavy render) | Keeps typing responsive on 1k-row tables; replaces partial `useDeferredValue` approach | small per site | P1 |
| M4 | Add CSP header hardening: `'strict-dynamic'` + per-request nonce in nginx, remove `unsafe-inline` / `'unsafe-inline'` from `style-src-elem`, add `require-trusted-types-for 'script'` with named policy; wire `createScript` hook of `@originjs/vite-plugin-federation` to set `integrity` attribute | Closes FE-HIGH-001 / FE-CRITICAL-003 class (post-load JS hash verification race) and satisfies MF SRI rule | medium (nginx + host entry) | P0 |
| M5 | Offload AES-GCM in `offline-queue.ts` to a Web Worker for payload > 100 KB (photo attachments, bulk sync) | Avoids main-thread jank on rural networks | medium | P2 |
| M6 | Enforce version lockstep: shell/shared-ui/all remotes on identical React 18.3.1, Vite 5.x, eslint-plugin-react-hooks ≥5 (shared-ui currently ^4.6.0) | Closes MF strictVersion drift risk; unifies lint rules | small | P1 |
| M7 | Replace legacy `useAsyncData` LRU cache in admin-panel (ADR-009) with TanStack Query v5 across admin-panel — ADR-009 is already accepted but admin-panel still imports `useAsyncData` | Single data-fetch paradigm, removes 4 `any` sites in useAsyncData.ts | medium | P2 |
| M8 | Decouple aquamobil from Vite 5 → align with shell as one upgrade job; or document why aquamobil stays on 5.x | Removes divergent Vite major across the monorepo | small (bump + test) | P2 |

---

## Findings

### FE-CRITICAL-001 — React Query keys bypass tenant prefix on a massive scale → cross-tenant cache leak on tenant switch
- **Evidence:** `createTenantQueryKey()` exists (`web/shared-ui/src/utils/tenant-query-keys.ts:39`) and is adopted in only 4 files: `web/shared-ui/src/utils/tenant-query-keys.ts`, `web/modules/dashboard/src/hooks/useDashboardData.ts`, `web/modules/dashboard/src/widgets/LiveSensorWidget.tsx`, `web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts`. Meanwhile, `web/modules/tenant-admin/src/pages/TenantDashboard.tsx:150,172,182` uses `['dashboard', 'modules']` / `['dashboard', 'users']` / `['dashboard', 'subscription']` with ZERO tenant component. `web/apps/aquamobil/src/hooks/useLeave.ts:87,144,184` uses `['leaveBalances', tenantId, year]` — tenantId is present but NOT as the `['tenant', id, ...]` prefix, so prefix-match invalidation via `['tenant', oldId]` can never match any of these keys. 265 queryKey call-sites in farm-module alone, 102 in sensor-module — essentially none conform.
- **Why it matters:** On tenant switch or admin impersonation, `queryClient.invalidateQueries({ queryKey: ['tenant', oldTenantId] })` is the intended one-shot purge. With bare keys, the purge silently matches nothing, and the UI for tenant B is painted with tenant A's cached data until each query's own `staleTime` expires. This is the exact multi-tenant data-leak class the factory was written to prevent.
- **Root-cause fix (tier 1 — make it impossible):** Turn the factory into a brand/phantom-type: `type TenantQueryKey<T extends readonly unknown[]> = readonly ['tenant', string, ...T]`. Type `useQuery` wrapper accepts only `TenantQueryKey`. Add an ESLint rule banning string-literal-first `queryKey:` arrays.
- **Severity:** CRITICAL. Delivers the same failure mode as FE-CRITICAL-002 (2026-04-10) but across the query-cache dimension instead of IndexedDB. Escalated one level because the factory was shipped but adoption stalled — repeat failure class.

### FE-CRITICAL-002 — SRI integrity check performed in application JS, not at browser script-load time; `cdn.jsdelivr.net` allowlisted
- **Evidence:** `web/shell/src/utils/remoteIntegrity.ts:144-201` validates `src` and sets `scriptElement.integrity = pin` inside the `createElement`/`setAttribute` patch. The prior review noted this pattern is the "post-load hash verification = race-with-execution" failure mode called out in the domain rules. `web/shell/index.html:19` allows `script-src 'self' https://cdn.jsdelivr.net` with no hash / nonce / `strict-dynamic`.
- **Why it matters:** Domain rule: *"MUST attach SRI via Module Federation runtime plugin `createScript` hook — the browser performs the check."* The current implementation still relies on a JS prototype patch being installed before any attacker code runs. Any earlier browser extension, any bookmarklet, any preload hint consumed before `main.tsx` — all race the patch. Domain rule also forbids CDN-sourced scripts without SRI hash; jsdelivr is broadly allowed.
- **Root-cause fix (tier 1):** Switch federation integrity to `@module-federation/enhanced` runtime plugin `createScript` hook so the browser performs the check natively. In parallel, remove `cdn.jsdelivr.net` from CSP or pin its entries by SHA-384 hash in `script-src`. Move CSP to nginx with nonce + `'strict-dynamic'`.
- **Severity:** CRITICAL.

### FE-HIGH-001 — Tech anchor drift between task description and repo reality (Vite 5 vs "7.3.1", React 18.3.1 vs "18.2", eslint plugin 4.x vs 5.0.0 in shared-ui)
- **Evidence:** `web/shell/package.json:34` = `"vite": "^5.0.0"`; `web/shared-ui/package.json:54` = `"eslint-plugin-react-hooks": "^4.6.0"`; `web/apps/aquamobil/package.json:38` = `"vite": "^5.4.0"`. Task description asserts Vite 7.3.1 / plugin 5.0.0.
- **Why it matters:** Part B agent knowledge updates and Part C skills catalog are driven by this audit. Authoring skills/knowledge against Vite 7 HMR, React 19 Server Actions, or react-hooks v5 rules that don't fire in shared-ui would bake false invariants into the gate tier.
- **Root-cause fix:** Either execute the Vite 5→7 / hooks 4→5 upgrade in a dedicated package and then publish the audit, OR publish the audit with the pinned-reality anchors and defer the upgrade to its own tracked plan phase with owner + deadline + finding ID. No "for now" / "good enough" middle ground.
- **Severity:** HIGH.

### FE-HIGH-002 — GraphQL codegen pipeline exists but produces no artifact and no consumer
- **Evidence:** `codegen.ts:16` generates to `web/shared-ui/src/generated/graphql-types.ts`. The directory `web/shared-ui/src/generated/` returns no files via Glob. `grep 'graphql-types'` over `web/` matches zero imports. 243 hand-written query/mutation string literals live across 30+ `*.operations.ts` files, all typed as `any` or hand-maintained interfaces.
- **Why it matters:** ADR-009 standardises the data-fetch pattern but is silent on type generation; in practice the shell and every MFE pay the cost of hand-keeping request/response types aligned with backend schemas. This produces the 114 `any` + 89 `as any` observations in Table 2.
- **Root-cause fix:** Adopt `client-preset` + `typed-document-node`; generate per workspace under a shared lib; run on every CI build; type `graphqlClient.request<DocumentType<typeof Query>>`.
- **Severity:** HIGH.

### FE-HIGH-003 — Meta-tag CSP fallback in `web/shell/index.html` still allows cross-origin script loads from `cdn.jsdelivr.net` without SRI / nonce
- **Evidence:** `web/shell/index.html:19-20` `script-src 'self' https://cdn.jsdelivr.net` and `script-src-elem 'self' https://cdn.jsdelivr.net`. No `strict-dynamic`, no nonce, no hash. Style sources still carry `'unsafe-inline'` (accepted for `style-src-elem` because Tailwind arbitrary values produce inline style attributes — documented as acceptable in ADR-010).
- **Why it matters:** The domain rule explicitly requires `script-src 'nonce-{random}' 'strict-dynamic'` in prod. The fallback meta CSP is the one enforced in local dev and any environment where the nginx header is missing — it is the weakest-link policy.
- **Root-cause fix:** Make nginx CSP authoritative; remove `cdn.jsdelivr.net` or replace with a self-hosted/SRI-pinned version; remove the meta-tag fallback once header delivery is invariant. Covered jointly with M4.
- **Severity:** HIGH.

### FE-HIGH-004 — shared-ui out of lockstep on `eslint-plugin-react-hooks` (^4.6.0) vs. every other workspace (5.0.0)
- **Evidence:** `web/shared-ui/package.json:54` vs `web/modules/*/package.json` and aquamobil.
- **Why it matters:** Rules-of-hooks v5 adds stricter `useEffect` dep detection. shared-ui is the highest-leverage workspace (AuthContext, api-client, token-lifecycle) — the one place where missing-dep bugs have the largest blast radius — and is the only one with the weaker rule set.
- **Root-cause fix:** Upgrade `eslint-plugin-react-hooks` to ^5.0.0 in shared-ui; fix any lint fallout in one commit.
- **Severity:** HIGH.

### FE-HIGH-005 — Broad `queryClient.invalidateQueries({ queryKey: ['dashboard'] })` — tenant-agnostic refetch storm
- **Evidence:** `web/modules/tenant-admin/src/pages/TenantDashboard.tsx:222`, `web/apps/aquamobil/src/hooks/useLeave.ts:234,235,266,267`, 8 more call-sites.
- **Why it matters:** Domain rule: *"MUST invalidate with the narrowest precise query key on mutation success. Broad invalidation = MEDIUM"* — escalated to HIGH because it compounds with FE-CRITICAL-001: if the key were tenant-prefixed, the invalidation would still be tenant-scoped. Today it refreshes every tenant's data on the current tab.
- **Root-cause fix:** Combined with FE-CRITICAL-001 — invalidation follows key shape.
- **Severity:** HIGH.

### FE-MEDIUM-001 — PageLoader spinners in AquaMobil lack ARIA live-region semantics
- **Evidence:** `web/apps/aquamobil/src/App.tsx:124-130` renders a spinner without `role="status"` + visually-hidden text.
- **Why it matters:** Suspense fallbacks are the keyboard / screen-reader pause points during lazy route loads. Silent spinners breach WCAG 4.1.3.
- **Root-cause fix:** Wrap spinner in `<div role="status" aria-live="polite">` and include `<span className="sr-only">Loading page</span>`.
- **Severity:** MEDIUM.

### FE-MEDIUM-002 — `useTransition` is effectively unused for heavy filter/search interactions
- **Evidence:** Only `useDeferredValue` appears (hr-module EmployeesListPage, hydroponics PID). Farm-module list pages carry 100+ rows with client-side filters and no transition wrapping.
- **Why it matters:** React 18's transitions are the standard defense against input-lag under CPU pressure. Not adopting them is not a bug — but it is Modernization P1 because the enterprise SaaS tables already exist and will only grow.
- **Root-cause fix:** Roll out transition wrappers at the filter-state callsites; publish a `useFilterTransition()` helper in shared-ui.
- **Severity:** MEDIUM.

### FE-MEDIUM-003 — `useGraphQL.ts` hooks are a parallel paradigm to TanStack Query
- **Evidence:** `web/shared-ui/src/hooks/useGraphQL.ts:66-201` exposes `useGraphQLQuery` / `useGraphQLMutation` with their own `QueryState<T>` shape; they do not register with the QueryClient. The file also includes three deprecated no-op shims (`usePrefetchQuery`, `useUpdateQueryCache`, `useInvalidateQueries`).
- **Why it matters:** Drift from ADR-009 intent. Hooks that live outside QueryClient don't share dedup, retry, or tenant-scoped invalidation.
- **Root-cause fix:** Deprecate with codemod; route every call-site to `useQuery({ queryKey: createTenantQueryKey(...), queryFn: () => graphqlClient.request(...) })`.
- **Severity:** MEDIUM.

### FE-LOW-001 — `React.memo` used only once on `ProtectedRoute` in shell; most feature components render unmemoized
- **Evidence:** `web/shell/src/App.tsx:72` has `memo(...)`. shared-ui `useMemo`/`useCallback` coverage is healthy, but feature components in modules are largely unmemoized.
- **Why it matters:** Default acceptable; only matters for hot-path widgets.
- **Root-cause fix:** Profile-driven — not a systemic change.
- **Severity:** LOW.

### FE-LOW-002 — Redundant `@ts-ignore` in `st-language.ts`
- **Evidence:** `web/modules/sensor-module/src/components/automation/st-language.ts:1`.
- **Root-cause fix:** Verify and replace with a typed declaration or remove.
- **Severity:** LOW.

---

## ADR drift check

| ADR | Enforcement kind today | Gap | Severity |
|---|---|---|---|
| ADR-009 (frontend data-fetch) | Documented; partially implemented. `useAsyncData` is standardized in admin-panel; `useGraphQL` + TanStack Query split in shell/modules; no lint gate. | No structural rule prevents inline `fetch()`; no codegen types consumed. See FE-HIGH-002 + FE-MEDIUM-003. | HIGH |
| ADR-010 (frontend styling) | Runtime: Tailwind config wired in 7 packages. Lint: none. | Inline `style={{}}` drift in 12 admin-panel files (documented as accepted debt). | LOW — keep as tracked debt |
| Module Federation strictVersion | Structural: `SharedDepConfig` TS type has literal `strictVersion: true`. Enforced by compile. | No gate yet that shared-ui's `eslint-plugin-react-hooks` matches modules. | MEDIUM (FE-HIGH-004) |
| Tenant-scoped cache isolation | Partial: factory exists, adoption incomplete. | See FE-CRITICAL-001. | CRITICAL |
| SRI on MF remotes | Allowlist + post-load hash check | Not browser-enforced (FE-CRITICAL-002) | CRITICAL |

---

## References (absolute paths)

- `/var/aqua-saas/web/shell/src/main.tsx`
- `/var/aqua-saas/web/shell/src/bootstrap.tsx`
- `/var/aqua-saas/web/shell/src/App.tsx`
- `/var/aqua-saas/web/shell/src/utils/remoteIntegrity.ts`
- `/var/aqua-saas/web/shell/src/components/ErrorBoundary.tsx`
- `/var/aqua-saas/web/shell/vite.config.ts`
- `/var/aqua-saas/web/shell/index.html`
- `/var/aqua-saas/web/shell/package.json`
- `/var/aqua-saas/web/shared-ui/src/index.ts`
- `/var/aqua-saas/web/shared-ui/src/federation/federationSharedConfig.ts`
- `/var/aqua-saas/web/shared-ui/src/contexts/AuthContext.tsx`
- `/var/aqua-saas/web/shared-ui/src/contexts/TenantContext.tsx`
- `/var/aqua-saas/web/shared-ui/src/utils/api-client.ts`
- `/var/aqua-saas/web/shared-ui/src/utils/token-lifecycle.ts`
- `/var/aqua-saas/web/shared-ui/src/utils/tenant-query-keys.ts`
- `/var/aqua-saas/web/shared-ui/src/utils/logout-cleanup.ts`
- `/var/aqua-saas/web/shared-ui/src/hooks/useGraphQL.ts`
- `/var/aqua-saas/web/shared-ui/src/components/ConfiguredBrowserRouter.tsx`
- `/var/aqua-saas/web/shared-ui/package.json`
- `/var/aqua-saas/web/modules/dashboard/vite.config.ts`
- `/var/aqua-saas/web/modules/dashboard/src/Module.tsx`
- `/var/aqua-saas/web/modules/dashboard/src/widgets/LiveSensorWidget.tsx`
- `/var/aqua-saas/web/modules/farm-module/vite.config.ts`
- `/var/aqua-saas/web/modules/sensor-module/vite.config.ts`
- `/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantDashboard.tsx`
- `/var/aqua-saas/web/modules/hr-module/src/pages/employees/EmployeesListPage.tsx`
- `/var/aqua-saas/web/modules/hydroponics-module/src/hooks/useCalculation.ts`
- `/var/aqua-saas/web/apps/aquamobil/vite.config.ts`
- `/var/aqua-saas/web/apps/aquamobil/src/App.tsx`
- `/var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts`
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts`
- `/var/aqua-saas/web/apps/aquamobil/package.json`
- `/var/aqua-saas/codegen.ts`
- `/var/aqua-saas/docs/adr/009-frontend-data-fetch-pattern.md`
- `/var/aqua-saas/docs/adr/010-frontend-styling-strategy.md`
- `/var/aqua-saas/docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md`
