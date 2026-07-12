# Admin Panels Enterprise Overhaul — Findings of Record (2026-07-12)

Scope: `web/modules/admin-panel` (SUPER_ADMIN), `web/modules/tenant-admin` (TENANT_ADMIN), their
backend counterparts (`apps/admin-api-service`, auth/billing/messaging/sensor GraphQL surfaces),
and the shared frontend infrastructure both panels depend on (`web/shared-ui`, `web/shell`).

Produced by a coordinated audit: 3 exploration passes, 2 frontend↔backend parity audits
(admin-panel REST ↔ admin-api-service controllers; tenant-admin GraphQL ↔ auth/billing/ai/sensor
resolvers), and 4 expert plan reviews (admin-expert, frontend-expert, auth-security-expert,
architectural-arbiter). Implementation branch: `claude/frontend-admin-panels-enterprise-ygyy5l`.

Parity result of record: tenant-admin GraphQL parity is CLEAN — all 56 operations match backend
resolvers, arguments, and field selections. admin-panel REST parity is NOT clean — the findings
below capture every defect.

**ID-namespace note:** an earlier, differently-scoped "ADMIN-HIGH-003" exists at the review-doc
level only (`docs/reviews/platform-kernel-expert/2026-06-24-event-reliability-outbox-ssot.md` —
admin-api in-process `@nestjs/cqrs` dead publishes; cross-referenced in the registry notes of
ALERT-CRITICAL-001). It was never registered in `findings.jsonl`. To keep one ID = one finding,
this review starts its HIGH sequence at **ADMIN-HIGH-004** and does not reuse 003.

---

## Implemented in this cycle

## ADMIN-HIGH-004 — tenant-admin specs never run in CI (missing nx `test` target)

**State:** OPEN → fixed in this cycle

`web/modules/tenant-admin/project.json` declares only `serve`/`build`/`preview`/`lint` targets.
The module has real specs (`src/__tests__/Module.spec.tsx`, `src/pages/__tests__/*.spec.tsx`,
`src/hooks/__tests__/useTenantRoles.spec.ts`), a `"test": "vitest run"` npm script, and vitest
config (`vite.config.ts:51-55`) — but `nx affected --target=test` silently skips the project.
A permanently-absent suite is a disabled CI signal (same class as SENSOR-MEDIUM-023).

Evidence:
- web/modules/tenant-admin/project.json
- web/modules/tenant-admin/vite.config.ts:51-55

Resolution: add the nx `test` target mirroring admin-panel's (`dependsOn: ["shared-ui:build"]`,
`implicitDependencies: ["shared-ui"]`), baseline the suite, repair any latent reds surfaced.

## ADMIN-HIGH-005 — admin-panel baseline spec red (Turkish placeholder drift)

**State:** OPEN → fixed in this cycle

`web/modules/admin-panel/src/pages/__tests__/TenantManagementPage.spec.tsx:196,208` asserts
`getByPlaceholderText(/tenant ara/i)` while the source renders `placeholder="Search tenants..."`
(`TenantManagementPage.tsx:415`). `getByPlaceholderText` throws on no-match — the two tests are
red at baseline. Test/source language drift from a partial English migration.

Evidence:
- web/modules/admin-panel/src/pages/__tests__/TenantManagementPage.spec.tsx:196
- web/modules/admin-panel/src/pages/__tests__/TenantManagementPage.spec.tsx:208
- web/modules/admin-panel/src/pages/TenantManagementPage.tsx:415

Resolution: assert `/search tenants/i` (English is the binding language decision for the panels).

## ADMIN-HIGH-006 — dead non-tenant-scoped query-key factory in tenant-admin

**State:** OPEN → fixed in this cycle

`web/modules/tenant-admin/src/lib/query-keys.ts` exports a `tenantKeys` factory whose keys are
bare `['tenant', ...]` — NOT tenant-scoped via `createTenantQueryKey`. It has zero importers
(dead), but if ever adopted it would violate the FE-CRITICAL-014/015/016 cross-tenant cache
invariant. The live, correctly-scoped factory is `hooks/useTenantData.ts` `tenantKeys`.
Two same-named exports in one module is a landmine.

Evidence:
- web/modules/tenant-admin/src/lib/query-keys.ts
- web/modules/tenant-admin/src/hooks/useTenantData.ts:91

Resolution: delete the file (tier-1: make the wrong key shape impossible by removing it).

## ADMIN-HIGH-007 — admin-panel dead parallel react-query/GraphQL layer with undeclared dependency

**State:** OPEN → fixed in this cycle

A complete second data-fetching stack (`hooks/useAdminQuery.ts`, `useAdminMutation.ts`,
`adminQueryKeys.ts`, `useMessaging.ts`, `useAnnouncements.ts`, `graphql/messaging-operations.ts`)
exists with zero page importers — the abandoned "Sprint 6" migration. `useAdminQuery.ts` imports
`@tanstack/react-query`, which is not declared in the module's `package.json` (hoisting-dependent
resolution). ADR-009 designates `adminApi` + `useAsyncData` as the module's one standard.

Evidence:
- web/modules/admin-panel/src/hooks/useAdminQuery.ts
- web/modules/admin-panel/src/hooks/useAdminMutation.ts
- web/modules/admin-panel/src/hooks/adminQueryKeys.ts
- web/modules/admin-panel/src/hooks/useMessaging.ts
- web/modules/admin-panel/src/hooks/useAnnouncements.ts
- web/modules/admin-panel/src/graphql/messaging-operations.ts

Resolution: delete the entire layer.

## ADMIN-HIGH-008 — billing dashboard ships null metrics and a placeholder chart despite live endpoints

**State:** OPEN → fixed in this cycle

`BillingDashboardPage.tsx:67-73` hardcodes `activeSubscriptions`, `churnRate`,
`outstandingInvoices`, `growth`, `paymentSuccessRate` to `null` with TODOs, and renders a
"Revenue Chart Placeholder" (:433) — while the backend already serves `SubscriptionStats`
(`byStatus`, `churnRate`, `mrr`, `arr`, `averageRevenuePerUser`), `InvoiceStats` (`totalPending`,
`totalOverdue`) and revenue trend. Only payment success rate lacks a backend aggregate
(admin-api `billing.controller.ts` has `GET payments` list but no stats endpoint — verified
non-duplicative).

Evidence:
- web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:67-73
- web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:433
- web/modules/admin-panel/src/services/types/billing.ts:219
- web/modules/admin-panel/src/services/types/billing.ts:257
- apps/admin-api-service/src/billing/billing.controller.ts:361

Resolution: compose the existing stats endpoints into the dashboard; add
`GET /billing/payments/stats` (new aggregate in `payment-management.service.ts`); replace the
placeholder with the shared-ui `AreaChart` wired to the existing 3m/6m/12m range select.

## ADMIN-HIGH-009 — messaging monitoring stats and tenant overview return 501

**State:** OPEN → fixed in this cycle

`apps/admin-api-service/src/messaging/messaging-admin.controller.ts:249` (`monitoring/stats`) and
`:300` (`tenants`) return HTTP 501 by design; `MessagingMonitoringPage` renders an honest
"Not Yet Available" stub and `MessagingTenantsPage` cannot list tenants. messaging-service has no
cross-tenant aggregation service.

Evidence:
- apps/admin-api-service/src/messaging/messaging-admin.controller.ts:249
- apps/admin-api-service/src/messaging/messaging-admin.controller.ts:300
- web/modules/admin-panel/src/pages/messaging/MessagingMonitoringPage.tsx

Resolution (arbiter-ruled design): new `MonitoringStatsService` in messaging-service aggregating
the authoritative `messaging.*` tables with `GROUP BY "tenantId"` inside
`BypassRlsService.withBypass()` (pattern of `retention-policy.service.ts`) — NOT per-tenant-schema
iteration over the vestigial post-ADR-013 clones. Single low-cardinality Redis key
(`messaging:admin:monitoring-stats`, 60s TTL). Two new `@MessagePattern`s on
`messaging-admin-nats.handler.ts`; controller replaces both 501s with typed `sendNatsRequest`.

## ADMIN-HIGH-010 — tenant security policy (MFA enforcement, session timeout) neither persisted nor enforced

**State:** OPEN → fixed in this cycle

tenant-admin `SecuritySettings.tsx` is a "not yet available" stub (SEC-005): no store, no
enforcement. The retired admin-api `TenantSecurityConfig` shape still *synthesizes* defaults
(`mfaRequired:false`, `sessionTimeoutMinutes:480`) on `GET settings/tenant/:id/security` reads
while its writes are 410-Gone — a dangling contract with no enforcement anywhere.

Evidence:
- web/modules/tenant-admin/src/components/settings/SecuritySettings.tsx
- apps/admin-api-service/src/settings/services/tenant-configuration.service.ts:251-261
- apps/admin-api-service/src/settings/controllers/tenant-configuration.controller.ts:289-304
- apps/auth-service/src/modules/authentication/services/authentication.service.ts:341

Resolution (per auth-security + arbiter co-design, recorded as an ADR): auth-service is the SSoT
for enforced tenant auth-security policy. Typed nullable columns on `auth.tenants`
(`enforce_mfa`, `session_timeout_minutes` 5–1440) — read for free in the existing login query,
no RLS fail-open (tenants is in `AUTH_RLS_EXCLUDE_TABLES`), no hot-path N+1. Not exposed on the
public GraphQL `Tenant` type; TENANT_ADMIN-guarded query/mutation with a dedicated ObjectType,
tenantId from `@CurrentUser`. Enforcement: fail-closed `mfaSetupRequired` login outcome with a
short-lived `mfa_setup`-typed token authorizing only `setupMfa`/`verifyMfaSetup`; refresh-token
TTL clamped to `MIN(tenant policy, rememberMe)` (idle semantics); flipping `enforce_mfa=true`
revokes refresh tokens of tenant users without MFA + emits a SecurityEvent. Requires
auth-security-expert co-review before merge.

Deliberate simplification (backlog): `enforce_mfa` is a boolean; the retired contract's
`mfaRequiredForAdmins` (admins-only) intermediate is not modeled in this cycle.

## ADMIN-HIGH-011 — live admin-panel pages call broken REST paths

**State:** OPEN → fixed in this cycle

Three reachable UI actions call wrappers whose backend routes do not exist:
1. `ErrorTrackingPage.tsx:158` → `updateErrorStatus` → `PUT /system/errors/groups/:id/status`
   (no such route; backend has purpose-built `POST groups/:id/acknowledge` and `assign`).
2. `ImpersonationPage.tsx:328` → `getSessionActions` — a guarded stub that throws on click.
   The data is already returned by `GET /impersonation/sessions/:id` (`actionsPerformed` jsonb,
   capped at the last 1000 actions — the read is lossy for longer sessions, documented here).
3. `FeatureTogglesPage.tsx:108` → `toggleFeature` → `POST feature-toggles/:id/toggle` (no such
   route; backend has `PUT feature-toggles/:id`). The status switch on the page 404s today.

Evidence:
- web/modules/admin-panel/src/services/api/settings.ts:195
- web/modules/admin-panel/src/pages/ErrorTrackingPage.tsx:158
- apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts:309
- web/modules/admin-panel/src/services/api/impersonation.ts:81
- web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:328
- apps/admin-api-service/src/impersonation/services/impersonation.service.ts:846-881
- web/modules/admin-panel/src/services/api/settings.ts:114
- web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:108
- apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:463

Resolution: rewire each caller to the existing backend route (`acknowledge`/`assign`;
`getSession.actionsPerformed`; `PUT feature-toggles/:id`), delete the broken wrappers, and add a
tier-3 CI invariant locking FE literal paths to the admin-api route manifest.

## ADMIN-HIGH-012 — tenant user deactivation is one-way in the UI

**State:** OPEN → fixed in this cycle

tenant-admin can deactivate a user (`useDeactivateTenantUser`) but has no reactivate or unlock
action — deactivation is a one-way trapdoor requiring platform-admin intervention. The backend
resolvers already exist and are TENANT_ADMIN-guarded with tenant-scoped lookups
(`where: { id, tenantId: admin.tenantId }`).

Evidence:
- web/modules/tenant-admin/src/hooks/useTenantData.ts:605
- apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:165
- apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:179
- apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:677-679

Resolution: wire `activateTenantUser`/`unlockTenantUser` into the user row actions.

## ADMIN-HIGH-013 — admin-api-service baseline-red test suites (41 failures)

**State:** OPEN → fixed in this cycle

Discovered while verifying the parity fixes: 4 suites / 41 tests in admin-api-service fail with
NO working-tree changes (verified via `git stash`): `user-permissions.spec.ts`,
`tenant.integration.spec.ts`, `tenant-erasure.handler.spec.ts`,
`email-circuit-breaker.spec.ts`. Spec-vs-implementation mock drift (e.g. the circuit-breaker spec
mocks a transporter the service no longer sees — "SMTP not configured"). Same disabled-CI-signal
class as ADMIN-HIGH-004/005 and SENSOR-MEDIUM-023.

Resolution: repaired in-cycle. Root causes: email spec mocked the retired async
`getEmailConfig()` seam (service now uses sync `getEmailConfigForSending()`); the erasure spec
hardcoded a 10-service roster that grew to 12 (now asserts the exported
`TENANT_ERASURE_TARGET_SERVICE_COUNT` SSoT); the tenant integration module missed the newly
injected `OutboxPublisher` provider; and — a **genuine production defect** — 
`UserPermissionsService.mergePermissions` wrote merged categories into a per-iteration shallow
copy and returned the untouched original, so `updatePermissions` silently dropped EVERY
permission change (fail-silent authz update reporting success). The service now merges into the
returned object; the pre-existing specs asserting the deep-merge contract pass.

## ADMIN-MEDIUM-001 — CRIT-04 deviation: 5 hooks bypass the lib/api.ts SSoT

**State:** OPEN → fixed in this cycle

`useTenantBilling`, `useTenantAuditLog`, `useTenantActivity`, `useDevicePolling`,
`useAiProviderSettings` call the deprecated `graphqlRequest` from
`services/tenant-api.service.ts:148` instead of the typed `lib/api.ts` functions (CRIT-04 SSoT).

Evidence:
- web/modules/tenant-admin/src/services/tenant-api.service.ts:148
- web/modules/tenant-admin/src/hooks/useTenantBilling.ts
- web/modules/tenant-admin/src/hooks/useTenantAuditLog.ts
- web/modules/tenant-admin/src/hooks/useTenantActivity.ts
- web/modules/tenant-admin/src/hooks/useDevicePolling.ts
- web/modules/tenant-admin/src/hooks/useAiProviderSettings.ts

Resolution: migrate all five to `lib/api.ts` functions, extend the scoped `tenantKeys`, then
delete `graphqlRequest` (tier-1: the bypass path ceases to exist).

## ADMIN-MEDIUM-002 — native confirm()/alert() in 9 admin-panel pages

**State:** OPEN → fixed in this cycle

`window.confirm`/`alert` in PlanManagementPage:56, IpAccessRulesPage:133, DatabaseManagementPage
(confirm ×3 + alert ×8), DiscountCodePage:104, CustomPlansListPage:206, MaintenancePage:148/166/213,
DebugToolsPage:217, JobQueuePage:129/150, FeatureTogglesPage:174 — while other pages use the
design-system `ConfirmModal`. Inconsistent, unstyled, untestable, inaccessible.

Resolution: shared-ui `ConfirmModal` (explicit English labels) + toasts for results.

## ADMIN-MEDIUM-003 — no working toast system; useToast is per-component state

**State:** OPEN → fixed in this cycle

`web/shared-ui/src/hooks/useToast.tsx` holds toasts in per-component `useState` — two callers get
independent lists and `ToastContainer` must be manually rendered. Consumers exist and are broken
by this: shell `SettingsPage.tsx:1410,1477` (works only because it renders its own container) and
30+ farm-module call sites whose toasts render nowhere (no container). Neither admin panel has
any feedback system.

Evidence:
- web/shared-ui/src/hooks/useToast.tsx
- web/shell/src/pages/SettingsPage.tsx:1410
- web/modules/farm-module/src/test-utils/sharedUiMock.ts:112

Resolution: context-based `ToastProvider` mounted ONCE in the shell provider tree
(`web/shell/src/bootstrap.tsx`); `useToast()` stays backward-compatible (returns
`{ toast, toasts, dismiss }`); `ToastOptions` gains optional `action` (retry affordance) and
errors announce via an assertive live region. Behavior change: farm-module toasts become visible
— flagged for farm-expert QA in the PR.

## ADMIN-MEDIUM-004 — tenant-admin uses zero shared-ui components

**State:** OPEN → fixed in this cycle

tenant-admin imports only auth/query/graphql utilities from `@aquaculture/shared-ui` — every UI
primitive (tables, modals, badges, toggle, avatar, stat cards) is hand-rolled, duplicating
existing shared-ui components and diverging from the platform design system.

Resolution: migrate to shared-ui primitives under these verified constraints: known-total tables
→ `DataTable`; unknown-total tables (`UserListSection` cursor-style pagination) keep their custom
footer (no fabricated totals); nested modal chains keep `useFocusTrap` (shared-ui `Modal` has no
trap stack); shared-ui default accents accepted (visual change pre-approved by the user).

## ADMIN-MEDIUM-005 — duplicated saved-feedback logic; error-toast helper wired to nothing

**State:** OPEN → fixed in this cycle

`setSaved(true) + setTimeout(...,3000)` duplicated in GeneralSettings:45, NotificationSettings:74,
MobileSettings:120, AiAssistantSettings:76; `utils/error-handling.ts:269` defines a structured,
English, retry-aware `createErrorToast` that is connected to no renderer.

Resolution: success toasts via the shared toast system; `createErrorToast` mapped into `toast()`
with a retry `action`. Note: shared-ui `formatErrorForToast` was evaluated and rejected for the
panels — it returns hardcoded Turkish strings and drops the retry affordance.

## ADMIN-MEDIUM-006 — local MetricCard duplicate in BillingDashboardPage

**State:** OPEN → fixed in this cycle

`BillingDashboardPage.tsx:89` defines a local `MetricCard` duplicating shared-ui
`MetricCard`/`KpiCard`. Resolution: delete local copy; extend the shared component with a missing
optional prop if needed rather than keeping the fork.

## ADMIN-MEDIUM-007 — performance dashboard placeholder despite fetched trend data

**State:** OPEN → fixed in this cycle

`PerformanceDashboardPage.tsx:594-631` renders "Interactive Charts Coming Soon" while
`dashboard.trends` is already in the fetched response and `GET /system/performance/history`
(`performance.controller.ts:224`) exists. shared-ui ships `LineChart`/`ChartContainer`.

Resolution: render the trends with shared-ui charts; wire the range selector to the history
endpoint.

## ADMIN-MEDIUM-008 — hardcoded actor identity instead of auth context

**State:** OPEN → fixed in this cycle

`SubscriptionManagementPage.tsx:77,95` (`'admin'`), `MessagingPage.tsx:165,216`
(`senderName: 'Admin'`), `ErrorTrackingPage.tsx:132` (`resolveError(..., 'admin')`) — audit
trails record a literal instead of the acting admin. `useAuthContext()` is available.

Resolution: resolve the actor from `useAuthContext()` at all four sites.

## ADMIN-MEDIUM-009 — Turkish UI-string leaks across both panels

**State:** OPEN → fixed in this cycle

Binding decision: panel UI is English-only (no i18n infrastructure this cycle). Verified files
with Turkish user-visible strings and/or comments: admin-panel `Module.tsx:82` ("Yukleniyor..."),
`main.tsx`, `AdminDashboard.tsx`, `CreateTenantPage.tsx`, `CustomPlanBuilderPage.tsx`,
`DatabaseExplorerPage.tsx`, `EmailTemplatesPage.tsx`, `IpAccessRulesPage.tsx`, `MessagingPage.tsx`,
`ModulePricingPage.tsx`, `RoleManagementPage.tsx`, `TenantConfigurationPage.tsx`; tenant-admin
`EdgeDeviceDetailPage.tsx`, `EdgeDevicesPage.tsx`, `TenantDashboard.tsx`,
`InstallerKeyModal.tsx:153-186` ("Key Adı (opsiyonel)", "Örn: Üretim Hattı Installer", "Sınırsız",
"Süresiz"), `main.tsx`.

Resolution: translate to English; lock with a CI invariant (Turkish-character grep over both
panels' `src` must be empty) plus an explicit-English-props checklist for adopted shared-ui
components (see ADMIN-MEDIUM-018 — a src-scoped grep cannot see strings rendered from shared-ui).

## ADMIN-MEDIUM-010 — LocalizationSettings stub → typed timezone/date-format persistence

**State:** OPEN → fixed in this cycle

`LocalizationSettings.tsx` is a "coming soon" stub. Per the English-only decision there is no
language selector; what remains meaningful is timezone + date format.

Resolution: typed preference columns on `auth.tenants` (`timezone` IANA-validated, `date_format`
enum) — deliberately SEPARATE from the security policy fields (cohesion ruling: localization is
a preference, not a security control), never the untyped `settings` jsonb. TENANT_ADMIN-guarded
GraphQL surface; FE selects via `Intl.supportedValuesOf('timeZone')`.

## ADMIN-MEDIUM-014 — ~20 dead broken/guard-stub FE API wrappers (zero callers)

**State:** OPEN → fixed in this cycle

Wrappers with no callers whose routes don't exist (would 404) or that throw before fetching:
`database.ts` :56-61 (`resetSchema`/`optimizeSchema`/`analyzeSchema`), :108-115 (5 legacy
migration wrappers), :156 (`scheduleBackup` POST vs GET-only route), :198-204 (4 monitoring fns);
`settings.ts` :107 (`getFeatureToggleByKey`), :222 (`drainQueue`), :245-249
(`getScheduledJobs`/`getFailedJobs` — shadowed by `@Get(':id')` at `job-queue.controller.ts:399`,
they'd hit `getJob('scheduled')` — and `cleanupJobs`); `security.ts` :45 (`getUserActivities`);
`tenant-config.ts` :324 (`testWebhook`, + its `settings.ts:76` delegation alias);
`analytics.ts` :45-61 (4 guarded stubs); `impersonation.ts` :45 (`updatePermission` stub).

**Security note (binding):** the deleted `createMigration` wrapper accepted raw
`{ sql, rollbackSql }`. Its backend route must NEVER be implemented to "complete parity" — an
arbitrary-SQL migration endpoint is a remote-DDL primitive (CRITICAL class; migration execution
must select from a deploy-time allowlist).

Resolution: delete all wrappers + orphaned types; the route-parity CI invariant (ADMIN-HIGH-011
resolution) prevents recurrence.

## ADMIN-MEDIUM-015 — getSecurityDashboard: wrong-shape zero-caller duplicate

**State:** OPEN → fixed in this cycle

`security.ts:160-168` declares an inline response type for `GET /security/monitoring/dashboard`
that matches nothing the backend returns (only `activeIncidents` overlaps; `threatLevel`,
`unresolvedEvents`, `recentEvents` don't exist; `blockedThreats`→`threatsBlocked`,
`topThreats`→`topEventTypes` renamed). The sibling `getMonitoringDashboard` (:170) hits the same
endpoint with the verified-correct `BackendSecurityDashboardStats` type and is what
`SecurityDashboardPage.tsx:150,196` uses.

Resolution: delete the wrong duplicate.

## ADMIN-MEDIUM-016 — bulk role assignment and effective-permissions viewer unwired

**State:** OPEN → fixed in this cycle

Backend has `bulkAssignUserRole` (`tenant-role.resolver.ts:479`,
`@RequireTenantPermission('users:edit_permissions')`) and `getUserEffectivePermissions` (:511,
`users:view`) — tenant-admin UI exposes neither, though `components/users/BulkActions.tsx`
already exists to host bulk operations. (Per-user role *change* already exists via
`updateTenantUser(userId, { roleId })` — not a gap.)

Resolution: wire both into the users page.

## ADMIN-MEDIUM-017 — orphan endpoints that complete existing pages

**State:** OPEN → fixed in this cycle

Backend endpoints with no FE caller that complete actions already promised by existing pages:
JobQueuePage "Retry all failed" currently loops per-job `retryJob` — backend has
`POST /system/jobs/retry-failed` (`job-queue.controller.ts:452`); `purge-completed` (:458) and
per-job `GET :id/logs` (:436) are unwired; ErrorTrackingPage has no assign control though
`POST groups/:id/assign` exists (:319).

Resolution: wire them (bulk retry, purge w/ ConfirmModal, logs drawer, assign control).

## ADMIN-MEDIUM-018 — shared-ui components hardcode Turkish strings, unoverridable

**State:** OPEN → fixed in this cycle

`Table` pagination hardcodes `'kayıt'`, `'Önceki'`, `'Sonraki'` and default
`emptyMessage='Gösterilecek veri bulunamadı'` with no override for the nav labels
(`Table.tsx:205,213,239,285`); `ConfirmModal` defaults `confirmText='Onayla'`,
`cancelText='İptal'` and hardcodes the loading label `'İşleniyor...'` (`Modal.tsx:328-329,446`)
and a Turkish typed-confirmation label (:412). Adopting these in the English-only panels would
reintroduce Turkish invisibly to any src-scoped grep gate.

Resolution: additive optional label props with current Turkish defaults preserved (farm-module
unchanged); panels pass explicit English values; panels prefer the fully-English `DataTable` for
paginated tables.

## ADMIN-MEDIUM-019 — quick-view modal and individual suspend/activate flow unreachable

**State:** OPEN → fixed in this cycle

Found during the ADMIN-HIGH-005 spec repair: the old spec tested a "quick view" flow the page
could no longer reach. `TenantManagementPage` carries a fully built tenant detail modal with
Suspend/Activate actions, a suspend-reason modal, live handlers (`handleToggleStatus`,
`handleConfirmSuspend`) and live backend routes (`PATCH admin/tenants/:id/suspend|activate`) —
but nothing ever called `setIsDetailModalOpen(true)`. The trigger was lost in a refactor; the
individual (non-bulk) suspend/activate capability silently disappeared from the product.

Evidence:
- web/modules/admin-panel/src/pages/TenantManagementPage.tsx:482 (modal with no opener)
- apps/admin-api-service/src/tenant/tenant.controller.ts (suspend/activate routes)

Resolution: restore a Quick View row action wiring the existing modal; suspending from the modal
routes through the mandatory-reason modal; the detail modal closes when an action begins so the
operator sees the outcome. Covered by a new spec test (quick-view → suspend-with-reason →
`tenantsApi.suspend(id, reason)`).

## ADMIN-LOW-001 — dead admin-panel components

**State:** OPEN → fixed in this cycle

Zero-importer files: `components/TenantSelect.tsx`, `components/TenantMultiSelect.tsx`,
`components/database/QueryEditor.tsx` (801 lines) + `components/database/index.ts`,
`hooks/useTenants.ts` (exists only to serve the unused selects), empty `README.md` (0 bytes).
Resolution: delete. (`routes/adminRoutes.ts` was audited and is NOT dead — imported by
AdminDashboard and AnalyticsDashboardPage — kept.)

## ADMIN-LOW-002 — ghost federation exposes and ghost shell type declarations

**State:** OPEN → fixed in this cycle

admin-panel exposes `./UserManagement`, `./TenantManagement`, `./SystemSettings`
(`vite.config.ts:23-25`) that nothing imports (shell imports only `adminPanel/Module`); shell
`types/remote-modules.d.ts:60-77,88-116` declares those plus five tenant-admin sub-exports that
the remote never exposed. Verified: no importers, no infra chunk-name coupling, SRI manifest
regenerates at build.

Resolution: remove the exposes and the ghost declarations; keep `*/Module`.

## ADMIN-LOW-003 — AdminLayout decorative chrome and hardcoded docs link

**State:** OPEN → fixed in this cycle

Header search box filters nothing; notification bell shows a static red dot with no logic;
settings gear links nowhere; `admin-nav-items.tsx:227` hardcodes `http://localhost:3008/docs`.

Resolution: search becomes a real nav quick-filter over `admin-nav-items`; bell removed; gear →
`/admin/settings`; docs link from `VITE_ADMIN_API_DOCS_URL` (item hidden when unset).

## ADMIN-LOW-004 — tenant-admin dead service files

**State:** OPEN → fixed in this cycle

`services/tenantApi.ts` (empty tombstone) still re-exported by `services/index.ts:99`; unused
`rest()` transport on `services/api-client.ts:74`; deprecated `graphqlRequest`
(`tenant-api.service.ts:148`) removed after the ADMIN-MEDIUM-001 hook migration.

## ADMIN-LOW-005 — watch-mode test scripts stall non-interactive runs

**State:** OPEN → fixed in this cycle

`web/modules/admin-panel/package.json:12` and `web/shared-ui/package.json:34` define
`"test": "vitest"` (watch default) — their nx test targets hang in non-CI local runs.
Resolution: `"test": "vitest run"` in both (tenant-admin already correct).

## ADMIN-LOW-008 — vapor "Appearance" section in tenant settings

**State:** OPEN → fixed in this cycle

`TenantSettings.tsx:113-124` renders an Appearance section that is a pure "coming soon" stub with
no backing model. Resolution: remove it; custom theming/branding is a product-backlog item, not a
settings page promise.

---

## Recorded, NOT implemented this cycle (explicit debt — owner + deadline per CLAUDE.md)

All entries: `owner_user: by-okan@live.com`, `deadline: 2026-08-31`, `state: OPEN`.

## ADMIN-MEDIUM-011 — tenant payment-method self-service absent

`TenantBillingPage` is read-only; there is no GraphQL payment-method surface (billing is
Stripe-webhook-driven, ADR-016; verified: no `paymentMethod` resolver op exists). A proper
implementation is a multi-service payment feature: billing-service resolver + Stripe
SetupIntent/Elements flow + webhook reconciliation + PCI-scoped FE. Bolting it onto a
UI-consolidation PR would ship it under-reviewed.

## ADMIN-MEDIUM-012 — AI persona per-tenant configuration update

`messaging-admin.controller.ts:356` returns 501; personas are static via the registry service.
Requires a persistence model + AI-guardrail review for tenant-visible AI behavior changes.

## ADMIN-MEDIUM-013 — tenant IP-whitelist enforcement

The third control the old SecuritySettings stub promised. Enforcement lives on the gateway/auth
login path and needs spoofing-hardened client-IP extraction — a security-critical standalone
design. The shipped SecuritySettings UI deliberately renders ONLY enforced controls; no
unpersisted checkbox ships (no security theater).

## ADMIN-LOW-006 — gateway ServiceProxyService prefix table is dead configuration

`apps/gateway-api/src/proxy/service-proxy.service.ts:900-957` registers per-service prefixes
(including a `/api/billing` → billing-service entry) but is imported by no dispatch path;
production dispatch is nginx (`infrastructure/nginx/droplet.conf:359` routes `/api/` to
admin-api-service). Dead routing config that misleads readers (it misled this audit's first
pass). Gateway-domain cleanup, out of panel scope.

## ADMIN-LOW-007 — orphan backend-endpoint catalog (~80 endpoints, product triage needed)

UI-relevant admin-api endpoints with no frontend caller, after the ADMIN-MEDIUM-017 triage wired
the ones completing existing pages. Blind UI-wiring would be feature invention; each needs a
product decision. Catalog by controller:

- **billing.controller.ts**: `GET module-pricing/:moduleId`, `GET module-pricing/:moduleId/history`,
  `GET invoices/overdue`, `GET invoices/tenant/:tenantId`, `POST invoices/update-overdue`,
  `GET usage/tenant/:tenantId/metrics`
- **reports.controller.ts**: `GET reports/types`, `tenant-overview`, `churn-analysis`, `revenue`,
  `payments`, `module-usage`, `feature-usage`, `system-performance`, `export/pdf/:reportType`,
  `export/csv`
- **tenant.controller.ts**: `POST admin/tenants/:id/erasure` (GDPR erasure trigger)
- **users.controller.ts**: `POST users/tenant/invite`, `GET users/permission-categories`,
  `GET/PUT users/:id/permissions`, `GET users/tenant/users-with-permissions`
- **activity-log.controller.ts**: `GET login-attempts/:ipAddress`, `GET sessions/user/:userId`,
  `POST sessions/user/:userId/terminate`
- **audit-trail.controller.ts**: `POST security/audit/export`, `GET retention-policies/:id`,
  `GET retention-stats`
- **compliance.controller.ts**: `POST data-requests/:id/download`, `GET data-requests/status/overdue`,
  `GET data-requests/stats`, `GET reports/:id`, `GET requirements/:framework`, `GET data-inventory`
- **security-monitoring.controller.ts**: `GET events/stats/summary`, `GET incidents/stats/summary`,
  `GET threat-intelligence/check/:ip`, `GET threat-intelligence/stats`,
  `GET config/anomaly-detection`, `GET alerts/realtime`
- **global-settings.controller.ts**: versions CRUD + deploy/rollback, configs CRUD + bulk-update,
  `GET system/settings/status`
- **error-tracking.controller.ts**: `GET stats`, `POST groups/merge`, `GET occurrences`,
  `GET occurrences/:id`, alert-rules CRUD
- **job-queue.controller.ts**: `GET queues/:name/stats`, `POST schedule`, `POST recurring`,
  `POST :id/pause`, `POST :id/resume`
- **performance.controller.ts**: `GET services`, `GET alerts`, `GET/POST thresholds`, `GET snapshots`
- **messaging-admin.controller.ts**: (tenants overview wired this cycle; personas update deferred
  under ADMIN-MEDIUM-012)
- **impersonation.controller.ts**: `GET sessions/active/count`, `GET audit/summary`
- **debug-tools.controller.ts**: `GET debug/sessions/tenant/:tenantId`,
  `DELETE debug/cache/tenant/:tenantId`
- **settings.controller.ts**: `POST settings/key/:key/reset`, `GET/PUT settings/config/maintenance`,
  `GET settings/features/:featureKey`, `GET settings/export`, `POST settings/import`
- **ip-access.controller.ts**: `GET type/:ruleType`, `POST whitelist/bulk`, `POST blacklist/bulk`,
  `DELETE type/:ruleType/clear`, `GET stats`, `POST cleanup`
- **email-template.controller.ts**: `GET category/:category`, `GET categories`,
  `POST code/:code/override`, `POST render`, `POST validate`
- **explorer.controller.ts**: `GET schemas/:schema/tables/:table/structure`,
  `POST database/explorer/query` (raw query tool — treat with the same caution as the
  createMigration note above)
- **ticket.controller.ts**: `GET number/:ticketNumber`, `GET tenant/:tenantId`, `GET assigned/:userId`
- **onboarding.controller.ts**: `POST :tenantId/welcome-email`, `POST :tenantId/training`,
  `PUT :tenantId/training/:sessionId`
- **announcement.controller.ts**: `GET tenant/:tenantId/active`, `GET tenant/:tenantId/pending`
- **auth-service (tenant-admin-usable GraphQL, unwired)**: edge-device `updateEdgeDevice`,
  IO-config CRUD, `setDigitalOutput`, firmware ops, LoRa ops (sensor-service);
  `bulkUpdateMobileSettings`; billing reads (`invoices`, `payments`, `plans`) beyond the embedded
  `tenantBilling` view

---

## Cross-domain handoffs (recorded for the PR)

- **farm-expert**: shell-level ToastProvider makes farm-module's 30+ currently-invisible `toast()`
  calls render. Intended fix of a broken pattern, but a real UX change in the farm domain — QA pass
  requested.
- **auth-security-expert**: ADMIN-HIGH-010 enforcement changes (login path, `mfa_setup` token type,
  refresh-TTL clamp, revocation-on-flip) require sign-off before merge (arbiter ARCH-MEDIUM-002).
- **architectural-arbiter rulings honored**: auth-service SSoT ADR for tenant auth-security policy;
  messaging aggregation over authoritative `messaging.*` tables under BypassRls; HIGH IDs start at
  004; route-parity and Turkish-string CI invariants are non-optional.
