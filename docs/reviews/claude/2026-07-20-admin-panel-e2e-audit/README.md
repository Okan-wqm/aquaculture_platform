# Admin Panel (SUPER_ADMIN) End-to-End Audit — FE ↔ BE ↔ DB

**Date:** 2026-07-20 · **Scope:** all ~50 pages of `web/modules/admin-panel` + `apps/admin-api-service` (+ cross-service chains into auth/billing/messaging/notification/config services) + the `admin` schema and its migrations · **Branch:** `claude/admin-panel-e2e-audit-9b80i5`

## Methodology

18 parallel section auditors traced every page through the full chain — page component → hooks → `services/api/*` → nginx `/api → /api/v1` rewrite → admin-api controller (global `PlatformAdminGuard`, `ResponseInterceptor` envelope, platform `ValidationPipe`) → service → entity → migration → table (following cross-service NATS/HTTP hops where applicable). Every CRITICAL/HIGH finding is then re-examined by an independent adversarial verifier that must refute it against the real wiring before it is kept; confirmed findings receive a root-cause analysis and an architectural fix design (repo CLAUDE.md discipline: root-cause only, contract fixed at the source, pattern-level fix for systemic classes, named proof test, S/M/L effort).

## Status / coverage

- Findings total: **383** — with root-cause+fix design: **212**, REFUTED: **1**, PENDING (verification + fix design queued in staged continuation): **170**
- Current severity distribution (verified where available): **CRITICAL: 20**, **HIGH: 117**, **MEDIUM: 162**, **LOW: 83**
- Page verdicts: **BROKEN: 12**, **MOCK_ONLY: 2**, **NOT_WIRED: 2**, **PARTIAL: 32**, **WORKING: 2**
- Every PENDING entry keeps its auditor severity and full evidence; its root-cause/fix-design section will be appended by the staged continuation run. IDs (`APA-xxx`) are stable and safe to reference from `Closes:` lines.

## Executive summary

**The plumbing is sound; large parts of the product surface are hollow.** The positive verification first — these were checked adversarially, not assumed: the droplet routing chain (`/api` → nginx rewrite → `/api/v1` on admin-api-service), the global `PlatformAdminGuard` (RS256 JWT + SUPER_ADMIN on **all 35 HTTP controllers**, no unguarded endpoint, no `@Public` escape beyond health/password-reset), the `ResponseInterceptor` envelope contract, and entity↔migration↔registry parity across all **60 admin-schema tables** are correct. No cross-tenant data leak through the admin REST surface was found.

Against that solid base, the audit found the panel systematically over-promises:

1. **Tenant creation — the panel's flagship flow — is terminally broken** (APA-022, CRITICAL). `admin-api-service` never configures a NATS microservice transport, so every `@EventPattern` consumer in the service is dead code (APA-030). The provisioning saga publishes the onboarding event, then waits for acks that can never arrive: **100% of tenant creations end `FAILED` after the tenant was already activated with a live subscription** — a contradictory FAILED-but-ACTIVE terminal state.
2. **Verdict spread:** of the 50 audited pages only **2 are fully WORKING** (ModulePricing, CustomPlanBuilder). **12 are BROKEN** (CreateTenant, ProvisioningSettings, DiscountCode, MessagingAudit, MessagingCompliance, MessagingRetention, Tickets, Maintenance, ErrorTracking, JobQueue, Impersonation, DebugTools), 2 MOCK_ONLY (TenantConfiguration, RoleManagement), 2 NOT_WIRED, 32 PARTIAL.
3. **Control-plane theater:** feature toggles (APA-285), maintenance mode, IP access rules (APA-351), email templates (APA-344), system settings (APA-340), the admin plan catalog (APA-126), discount codes (APA-127), usage metering (APA-121) and the job queue all persist real rows **that nothing in the platform reads or enforces**. An admin who "blocks an IP" or "enables maintenance mode" changes nothing.
4. **False assurance on security/observability surfaces:** the threat dashboard always reports 100/healthy because its detection supply chain is dead (APA-240); the activity ledger has zero writers (APA-217); application metrics, error ingestion, and several financial/usage reports fabricate data or render hardcoded constants as live (APA-269, APA-274, APA-131, APA-138, APA-139).
5. **Deploy-topology risk:** on the `docker-compose.prod.yml` stack the whole admin REST surface 404s — that stack routes `/api` to gateway-api which has no admin proxy (APA-252); dev mode has no route to admin-api at all (APA-253). The panel only works on the droplet stack.
6. **Email settings answer** (explicitly asked): template CRUD persists to `admin.email_templates`, but **no real send path consumes the templates** (APA-344), the test-send endpoint is a stub that returns "email service integration required" (APA-345), "New Template" cannot be created due to a dead modal (APA-343), and SMTP "Send Test" tests env-var config rather than what the admin saved (APA-341). Editing an email template today has zero effect on any email the platform sends.

## Systemic root-cause classes

Most of the 383 findings are instances of 12 recurring classes. Fixing class-by-class (pattern fix + mechanical application) resolves the bulk of the findings at a fraction of the one-by-one cost. Representative findings cited; the full mapping is in each finding's *Fix design*.

| # | Class | Representative | Pattern fix (highest tier) |
|---|---|---|---|
| RC-1 | **Envelope/pagination contract break** — services return `{items,total}` or ad-hoc shapes; `ResponseInterceptor` only lifts `{data,total}`; FE expects bare arrays or `PaginatedResult{data}` → lists render permanently empty or crash | APA-283, APA-265, APA-279, APA-275, APA-106 | One canonical `PaginatedResult` DTO in a shared contract module used by BE services *and* FE types; interceptor lifts exactly that shape; contract test walks every list endpoint |
| RC-2 | **Interface-DTOs bypass `ValidationPipe`** — `@Body`/`@Query` typed with TS interfaces → global whitelist validation silently skipped (billing, messaging-admin, settings, modules, email templates…) | APA-128, APA-179 | Convert to class-validator DTOs; add an architecture spec asserting every `@Body`/`@Query` metatype is a decorated class — the class becomes structurally impossible to reintroduce |
| RC-3 | **Mixed named-`@Query` + bare `@Query()` DTO under `forbidNonWhitelisted`** → every filtered list request 400s (audit logs, tickets, custom plans…) | APA-013, APA-356 | One query-DTO per handler extending `PaginationQueryDto`; `ROUTE_ARGS_METADATA` architecture spec bans the mixed shape repo-wide |
| RC-4 | **FE payload fields not whitelisted by DTO** → mutations 400 (invite user, maintenance create, backup `encrypt`, feature-toggle edit…) | APA-049, APA-266, APA-314, APA-261 | Same contract-at-source discipline as RC-2/RC-3 + FE↔DTO parity contract tests with the *exact* FE payload key sets |
| RC-5 | **Hand-written FE types, no codegen** — field/vocabulary drift in both directions (severity vocab, role enums, `senderType`, stats shapes) | APA-004, APA-050, APA-197 | Shared vocabulary constants in `@aquaculture/shared-contracts` (+ compile-time equality assertions on the BE enums); mid-term: OpenAPI→TS client generation for admin-panel; delete the `KNOWN_DRIFT` allowlist |
| RC-6 | **Phantom endpoints & dead UI** — 19+ FE api functions target nonexistent routes; primary buttons with no handler; 10 mounted pages unreachable from any nav | APA-254, APA-255, APA-260 | Contract-parity test FE api layer ↔ Nest route table (no allowlist); nav SSoT diffed against `Module.tsx` routes in an invariant spec |
| RC-7 | **Control-plane theater** — persisted config with zero consumers/enforcement | APA-285, APA-351, APA-344, APA-340, APA-126, APA-127, APA-121 | Per feature: wire the named enforcement point (each finding's fix design names it) or remove the surface; new invariant: every admin-writable config table must have a registered consumer |
| RC-8 | **Telemetry with no producers / fabricated metrics** — ledgers nothing writes; silent-zero fallbacks; hardcoded "healthy" | APA-217, APA-240, APA-245, APA-269, APA-274 | Nullable measured-metric contract (`number\|null`, null = unmeasured, render as —); single `PrometheusQueryService` bridge for traffic/latency KPIs; producers wired via service-identity paths (not SUPER_ADMIN user JWT); delete silent-zero catch blocks |
| RC-9 | **Dead async wiring** — no NATS transport in admin-api; declared event consumers with no live listener | APA-022, APA-030 | Bootstrap fail-fast: `@EventPattern` handlers present but no `natsTransport` → cold-start failure; registry-derived event-consumer-liveness invariant; generalized saga wait/requeue primitive; barrier ordered before user-visible commitment |
| RC-10 | **Half-finished config-service migration** — legacy stores dropped, admin routes 410-tombstoned, promised replacement never built; reads fabricate defaults | APA-033, APA-047, APA-340 | Decide owner (config-service per ORPHAN-HIGH-364) and build the read/write path there, or restore admin-api ownership; either way delete the fabricated-defaults path; tombstoned routes must not ship live UI |
| RC-11 | **Split-brain persistence silos** — admin support/announcement/messaging tables disconnected from what tenants actually read; announcements never delivered (APA-201); support tickets 500 on hardcoded non-UUID actor IDs (APA-185/186) | APA-213 | Single ownership decision per silo: admin panel operates on the tenant-visible store via the owning service's API/NATS, not a parallel admin-schema copy |
| RC-12 | **Security hardening gaps** — CSRF double-submit inert platform-wide (header sent, never validated, cookie never issued); token blacklist not consulted by `PlatformAdminGuard`; impersonation token issued but unconsumable + append-only trigger on an operational table | APA-366, APA-367, APA-288, APA-289 | Implement server-side double-submit middleware (or remove the FE header and rely on the SameSite token model — decide, don't fake); blacklist check in the guard; impersonation chain wired end-to-end with scoped, revocable, audited tokens |

## Suggested remediation phasing (input for the implementation plan)

- **Phase 0 — restore the flagship flows (CRITICAL path):** RC-9 (NATS transport + saga ordering → tenant creation), support-ticket UUID actor fixes (APA-185/186), legal-hold release chain (APA-163), prod/dev routing topology (APA-252/253).
- **Phase 1 — contract layer (kills ~40% of findings mechanically):** RC-1 envelope/pagination, RC-2/3/4 DTO validation classes, RC-5 shared vocabularies + codegen, RC-6 parity gates.
- **Phase 2 — truth in telemetry & security surfaces:** RC-8 producers + nullable metrics, RC-12 CSRF/blacklist/impersonation.
- **Phase 3 — control-plane decisions:** RC-7 and RC-10/11 per-feature wire-or-remove decisions (product involvement needed: enforce module gating, IP rules, maintenance mode, email templates; unify support silos).
- **Phase 4 — polish:** MEDIUM/LOW UX findings (silent failures, pagination UIs, debounce, dead links).

Effort totals for the 85 designed findings so far: mostly **M** (2–8h) with a handful of **L**; per-finding grades are in the section files.

## Page verdict matrix

| Section | Page | Route | Verdict |
|---|---|---|---|
| [dashboard](findings/dashboard.md) | AdminDashboard | `/admin (index)` | **PARTIAL** |
| [tenants](findings/tenants.md) | TenantManagementPage | `/admin/tenants` | **PARTIAL** |
| [tenants](findings/tenants.md) | CreateTenantPage | `/admin/tenants/new` | **BROKEN** |
| [tenants](findings/tenants.md) | TenantDetailPage | `/admin/tenants/:tenantId` | **PARTIAL** |
| [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | `/admin/tenants/:tenantId/configuration` | **MOCK_ONLY** |
| [tenant-config](findings/tenant-config.md) | ProvisioningSettingsPage | `/admin/settings/provisioning` | **BROKEN** |
| [users-roles](findings/users-roles.md) | UserManagementPage.tsx | `/admin/users` | **PARTIAL** |
| [users-roles](findings/users-roles.md) | RoleManagementPage.tsx | `/admin/users/roles` | **MOCK_ONLY** |
| [modules](findings/modules.md) | ModulesPage | `/admin/modules` | **PARTIAL** |
| [billing-core](findings/billing-core.md) | BillingDashboardPage | `/admin/billing` | **PARTIAL** |
| [billing-core](findings/billing-core.md) | InvoicesPage | `/admin/billing/invoices (+ /admin/billing/invoices/new)` | **PARTIAL** |
| [billing-core](findings/billing-core.md) | PaymentsPage | `/admin/billing/payments` | **PARTIAL** |
| [billing-core](findings/billing-core.md) | BillingReportsPage | `/admin/billing/reports` | **PARTIAL** |
| [billing-plans](findings/billing-plans.md) | SubscriptionManagementPage | `/admin/billing/subscriptions` | **PARTIAL** |
| [billing-plans](findings/billing-plans.md) | PlanManagementPage | `/admin/billing/plans` | **PARTIAL** |
| [billing-plans](findings/billing-plans.md) | DiscountCodePage | `/admin/billing/discounts` | **BROKEN** |
| [billing-plans](findings/billing-plans.md) | ModulePricingPage | `/admin/billing/module-pricing` | **WORKING** |
| [billing-plans](findings/billing-plans.md) | CustomPlansListPage | `/admin/billing/custom-plans` | **PARTIAL** |
| [billing-plans](findings/billing-plans.md) | CustomPlanBuilderPage | `/admin/billing/custom-plans/new` | **WORKING** |
| [billing-plans](findings/billing-plans.md) | UsageDashboardPage | `/admin/billing/usage` | **PARTIAL** |
| [analytics](findings/analytics.md) | AnalyticsDashboardPage | `/admin/analytics` | **PARTIAL** |
| [analytics](findings/analytics.md) | ReportsPage | `/admin/analytics/reports` | **PARTIAL** |
| [messaging-monitoring](findings/messaging-monitoring.md) | MessagingMonitoringPage | `/admin/messaging/monitoring` | **NOT_WIRED** |
| [messaging-monitoring](findings/messaging-monitoring.md) | MessagingTenantsPage | `/admin/messaging/tenants` | **PARTIAL** |
| [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAuditPage | `/admin/messaging/audit` | **BROKEN** |
| [messaging-monitoring](findings/messaging-monitoring.md) | MessagingCompliancePage | `/admin/messaging/compliance` | **BROKEN** |
| [messaging-monitoring](findings/messaging-monitoring.md) | MessagingRetentionPage | `/admin/messaging/retention` | **BROKEN** |
| [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAiDashboardPage | `/admin/messaging/ai-dashboard` | **NOT_WIRED** |
| [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAiPersonasPage | `/admin/messaging/ai-personas` | **PARTIAL** |
| [support](findings/support.md) | TicketsPage | `/admin/support/tickets` | **BROKEN** |
| [support](findings/support.md) | MessagingPage | `/admin/support/messaging` | **PARTIAL** |
| [support](findings/support.md) | AnnouncementsPage | `/admin/support/announcements` | **PARTIAL** |
| [support](findings/support.md) | OnboardingPage | `/admin/support/onboarding` | **PARTIAL** |
| [security](findings/security.md) | ActivityLogPage | `/admin/security/activity` | **PARTIAL** |
| [security](findings/security.md) | AuditTrailPage | `/admin/security/audit` | **PARTIAL** |
| [security](findings/security.md) | CompliancePage | `/admin/security/compliance` | **PARTIAL** |
| [security](findings/security.md) | SecurityDashboardPage | `/admin/security/threats` | **PARTIAL** |
| [system-mgmt](findings/system-mgmt.md) | FeatureTogglesPage | `/admin/system/features` | **PARTIAL** |
| [system-mgmt](findings/system-mgmt.md) | MaintenancePage | `/admin/system/maintenance` | **BROKEN** |
| [system-mgmt](findings/system-mgmt.md) | PerformanceDashboardPage | `/admin/system/performance` | **PARTIAL** |
| [system-mgmt](findings/system-mgmt.md) | ErrorTrackingPage | `/admin/system/errors` | **BROKEN** |
| [system-mgmt](findings/system-mgmt.md) | JobQueuePage | `/admin/system/jobs` | **BROKEN** |
| [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | `/admin/system/impersonation` | **BROKEN** |
| [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | `/admin/system/debug` | **BROKEN** |
| [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | `/admin/database` | **PARTIAL** |
| [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | `/admin/database/explorer` | **PARTIAL** |
| [settings-email-audit](findings/settings-email-audit.md) | SystemSettingsPage.tsx | `/admin/settings` | **PARTIAL** |
| [settings-email-audit](findings/settings-email-audit.md) | EmailTemplatesPage.tsx | `/admin/settings/email` | **PARTIAL** |
| [settings-email-audit](findings/settings-email-audit.md) | IpAccessRulesPage.tsx | `/admin/settings/integrations` | **PARTIAL** |
| [settings-email-audit](findings/settings-email-audit.md) | AuditLogPage.tsx | `/admin/audit` | **PARTIAL** |

## Finding index

| ID | Sev | Status | Section | Page | Title |
|---|---|---|---|---|---|
| APA-001 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | KPI card 'API Calls (24h)' silently displays audit-log row count, not API calls |
| APA-002 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | Recent Activity feed self-pollutes: every 30s dashboard poll writes an AUDIT_LOG_ACCESSED row into t |
| APA-003 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | Platform metrics farm/sensor/alert-rule counts are structurally always 0 — the queried tables cannot |
| APA-004 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | Audit severity vocabulary drift: FE expects low/medium/high, backend emits info/warning/critical — w |
| APA-005 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | Service Status card can never show 'unhealthy' for remote services — a dead service renders as 'degr |
| APA-006 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | Total backend failure renders as an all-zero dashboard with no error message |
| APA-007 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | Cache card and 'Clear Cache' button are unreachable dead UI; backing /debug endpoints are 404 by def |
| APA-008 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | Circuit Breakers panel shows only the SMTP breaker — the platform's real cross-service breakers are  |
| APA-009 | MEDIUM | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | GET /system/services/health probes 12 services sequentially with 3s timeouts — worst case ~36s respo |
| APA-010 | LOW | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | 'System Resources' card shows only admin-api-service's own process stats, labeled as system-wide |
| APA-011 | LOW | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | 'Logins (Last 24h)' counts users with a recent lastLoginAt, not login events |
| APA-012 | LOW | ✅ designed | [dashboard](findings/dashboard.md) | AdminDashboard | AbortController is never wired to fetch — in-flight requests survive unmount and stale-abort |
| APA-013 | HIGH | ✅ designed | [dashboard](findings/dashboard.md) | (cross-cutting) | GET /audit-logs rejects every filter parameter with 400 due to forbidNonWhitelisted + mixed @Query p |
| APA-014 | LOW | ✅ designed | [dashboard](findings/dashboard.md) | (cross-cutting) | Frontend double-submit CSRF is a no-op: admin-api never issues nor validates the XSRF-TOKEN cookie |
| APA-015 | LOW | ✅ designed | [dashboard](findings/dashboard.md) | (cross-cutting) | Auth/envelope/routing chain verified sound for the dashboard (informational) |
| APA-016 | HIGH | ✅ designed | [tenants](findings/tenants.md) | TenantManagementPage | Bulk suspend/activate failures are completely silent |
| APA-017 | HIGH | ✅ designed | [tenants](findings/tenants.md) | TenantManagementPage | Bulk activity-log INSERT writes N x N cartesian rows with mismatched previous-status pairing |
| APA-018 | MEDIUM | ✅ designed | [tenants](findings/tenants.md) | TenantManagementPage | Trial badge and Last Activity column render fields the list DTO never carries |
| APA-019 | MEDIUM | ✅ designed | [tenants](findings/tenants.md) | TenantManagementPage | Stats cards stay stale up to 1 hour after lifecycle actions despite FE cache-busting |
| APA-020 | LOW | ✅ designed | [tenants](findings/tenants.md) | TenantManagementPage | Per-row suspend/activate UI is unreachable dead code on the list page |
| APA-021 | LOW | ✅ designed | [tenants](findings/tenants.md) | TenantManagementPage | tenants API surface exposes endpoints that cannot work |
| APA-022 | CRITICAL | ✅ designed | [tenants](findings/tenants.md) | CreateTenantPage | Onboarding-ack loop is dead — every tenant creation terminates FAILED after the tenant is already AC |
| APA-023 | MEDIUM | ✅ designed | [tenants](findings/tenants.md) | CreateTenantPage | wait_for_onboarding_ack has no pending/requeue semantics even if the transport were wired |
| APA-024 | LOW | ✅ designed | [tenants](findings/tenants.md) | CreateTenantPage | 'begin_provisioning' step is executed but missing from the seeded step catalog |
| APA-025 | LOW | ✅ designed | [tenants](findings/tenants.md) | CreateTenantPage | Success screen shows the locally computed price, not the provisioned subscription's amount |
| APA-026 | HIGH | ✅ designed | [tenants](findings/tenants.md) | TenantDetailPage | Edit Tenant modal can never succeed — the backend rejects every update by design while the FE still  |
| APA-027 | MEDIUM | ✅ designed | [tenants](findings/tenants.md) | TenantDetailPage | Billing tab is permanently empty: it reads admin.tenant_billing_info, which no code ever writes, ins |
| APA-028 | MEDIUM | ✅ designed | [tenants](findings/tenants.md) | TenantDetailPage | Overview renders lastActivityAt which was removed from the backend contract — always '-' |
| APA-029 | LOW | ✅ designed | [tenants](findings/tenants.md) | TenantDetailPage | Note update/delete ownership violations surface as HTTP 500, and user-stats errors are silently zero |
| APA-030 | HIGH | ✅ designed | [tenants](findings/tenants.md) | (cross-cutting) | admin-api-service has no NATS microservice transport — every @EventPattern consumer in the service i |
| APA-031 | MEDIUM | ✅ designed | [tenants](findings/tenants.md) | (cross-cutting) | Hand-written FE tenant types drift from backend DTOs in both directions (no codegen) |
| APA-032 | LOW | ⏳ pending | [tenants](findings/tenants.md) | (cross-cutting) | Auth, routing, and schema discipline for the tenants section verified sound (context, not a defect) |
| APA-033 | HIGH | ✅ designed | [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | Every mutation on the page returns 410 Gone — no tenant configuration can be changed at all |
| APA-034 | MEDIUM | ✅ designed | [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | All reads return fabricated, identical hardcoded defaults for every tenant — silent wrong data on a  |
| APA-035 | HIGH | ✅ designed | [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | The promised config-service replacement for tenant configuration does not exist anywhere |
| APA-036 | MEDIUM | ⏳ pending | [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | FE echoes whole GET objects back into PUTs whose DTOs lack fields — would 400 via forbidNonWhitelist |
| APA-037 | MEDIUM | ⏳ pending | [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | Failed tab loads leave an infinite spinner with only a dismissible banner |
| APA-038 | MEDIUM | ⏳ pending | [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | IP list UI invites CIDR ranges that the backend DTO rejects |
| APA-039 | LOW | ⏳ pending | [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | Unvalidated bodies on several endpoints: controller uses service interfaces as DTOs |
| APA-040 | LOW | ⏳ pending | [tenant-config](findings/tenant-config.md) | TenantConfigurationPage | testWebhook FE method targets a route that does not exist |
| APA-041 | HIGH | ✅ designed | [tenant-config](findings/tenant-config.md) | ProvisioningSettingsPage | Save always fails: PUT provisioning-config unconditionally throws 410 Gone and no replacement write  |
| APA-042 | MEDIUM | ✅ designed | [tenant-config](findings/tenant-config.md) | ProvisioningSettingsPage | Displayed 'settings' are process-env fallbacks, not stored configuration |
| APA-043 | HIGH | ✅ designed | [tenant-config](findings/tenant-config.md) | ProvisioningSettingsPage | The only downstream consumer (sensor-service installer scripts) can never reach this endpoint — sile |
| APA-044 | MEDIUM | ⏳ pending | [tenant-config](findings/tenant-config.md) | ProvisioningSettingsPage | Two of six form fields are ignored by the consumer even by design |
| APA-045 | MEDIUM | ⏳ pending | [tenant-config](findings/tenant-config.md) | ProvisioningSettingsPage | Asymmetric read/write contract with an unvalidated PUT body and an unsafe FE cast |
| APA-046 | LOW | ✅ designed | [tenant-config](findings/tenant-config.md) | (cross-cutting) | Tenant-creation default-configuration provisioning is a logged no-op — provisioning defaults affect  |
| APA-047 | HIGH | ✅ designed | [tenant-config](findings/tenant-config.md) | (cross-cutting) | Half-finished config-service migration: legacy stores dropped, but two live admin routes still point |
| APA-048 | LOW | ⏳ pending | [tenant-config](findings/tenant-config.md) | (cross-cutting) | Auth/routing plumbing for the audited surface is sound (verified, no finding) |
| APA-049 | HIGH | ✅ designed | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | Invite User flow can never succeed: FE sends non-whitelisted 'invitedBy' field, rejected by global V |
| APA-050 | CRITICAL | ✅ designed | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | Three-way role-vocabulary drift blocks create/edit for MODULE_MANAGER and MODULE_USER and breaks the |
| APA-051 | HIGH | ✅ designed | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | Invite modal role dropdown is driven by the RoleTemplateService catalogue whose codes mostly cannot  |
| APA-052 | MEDIUM | ⏳ pending | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | getTenantName queries unqualified 'tenants' table that does not exist on the admin search_path — ten |
| APA-053 | MEDIUM | ⏳ pending | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | GET /users/:id/activity always returns [] — selects a 'metadata' column that does not exist on auth. |
| APA-054 | MEDIUM | ⏳ pending | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | Search input validation rejects non-ASCII characters — searching Turkish names 400s and empties the  |
| APA-055 | MEDIUM | ⏳ pending | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | Admin reset-password backend is fully wired but no UI invokes it |
| APA-056 | MEDIUM | ⏳ pending | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | Silent failure: stats/tenants/role-templates fetch errors are swallowed — page degrades with no erro |
| APA-057 | LOW | ⏳ pending | [users-roles](findings/users-roles.md) | UserManagementPage.tsx | GET /users/:id/sessions ignores isRevoked — revoked but unexpired sessions display as active |
| APA-058 | MEDIUM | ✅ designed | [users-roles](findings/users-roles.md) | RoleManagementPage.tsx | Role and permission data is a hardcoded in-memory catalogue, not the persisted RBAC — page presents  |
| APA-059 | MEDIUM | ⏳ pending | [users-roles](findings/users-roles.md) | RoleManagementPage.tsx | Hierarchy contract drift: backend returns permissionCount, FE type expects permissions[] — permissio |
| APA-060 | LOW | ⏳ pending | [users-roles](findings/users-roles.md) | RoleManagementPage.tsx | Inconsistent role naming across the panel: catalogue labels MODULE_USER as 'Viewer' while UserManage |
| APA-061 | HIGH | ✅ designed | [users-roles](findings/users-roles.md) | (cross-cutting) | Systemic role-enum drift in admin-api-service DTOs: a role vocabulary ('MANAGER','OPERATOR','VIEWER' |
| APA-062 | MEDIUM | ⏳ pending | [users-roles](findings/users-roles.md) | (cross-cutting) | Two divergent nginx topologies for /api: droplet config targets admin-api-service with /api/v1 rewri |
| APA-063 | MEDIUM | ⏳ pending | [users-roles](findings/users-roles.md) | (cross-cutting) | Hand-written FE types drift from backend response shapes with no build-time detection |
| APA-064 | LOW | ⏳ pending | [users-roles](findings/users-roles.md) | (cross-cutting) | FE double-submit CSRF header is sent but admin-api never validates it |
| APA-065 | HIGH | ✅ designed | [modules](findings/modules.md) | ModulesPage | Catalog activate/deactivate toggle writes real state that almost nothing enforces |
| APA-066 | HIGH | ✅ designed | [modules](findings/modules.md) | ModulesPage | Toggle feedback silently wrong: refresh() after activate/deactivate serves the 30s useAsyncData cach |
| APA-067 | HIGH | ✅ designed | [modules](findings/modules.md) | ModulesPage | Assign-module-to-tenant with expiresAt throws 500: interface DTOs bypass the global ValidationPipe a |
| APA-068 | HIGH | ✅ designed | [modules](findings/modules.md) | ModulesPage | Module removal soft-disables (isEnabled=false) but every admin read path counts disabled rows as liv |
| APA-069 | HIGH | ✅ designed | [modules](findings/modules.md) | ModulesPage | Assignment quantities/configuration are stored corrupted and never read back |
| APA-070 | MEDIUM | ⏳ pending | [modules](findings/modules.md) | ModulesPage | assignedBy/removedBy audit fields record the TENANT UUID instead of the acting SUPER_ADMIN |
| APA-071 | MEDIUM | ⏳ pending | [modules](findings/modules.md) | ModulesPage | 'Add Module' button is dead — no onClick, create flow unreachable from the page |
| APA-072 | MEDIUM | ⏳ pending | [modules](findings/modules.md) | ModulesPage | tenant_modules.expiresAt is written but never enforced on any read path |
| APA-073 | LOW | ⏳ pending | [modules](findings/modules.md) | ModulesPage | Stats fetch errors are swallowed; fallback figures computed from a single page of 50 can be wrong |
| APA-074 | LOW | ⏳ pending | [modules](findings/modules.md) | ModulesPage | Search fires a request per keystroke despite the 'debounced' comment; filter clicks double-fetch |
| APA-075 | HIGH | ✅ designed | [modules](findings/modules.md) | (cross-cutting) | Per-tenant module disable is not enforced for non-admin users (MODULE_MANAGER / MODULE_USER) |
| APA-076 | MEDIUM | ⏳ pending | [modules](findings/modules.md) | (cross-cutting) | admin-api modules controller pattern (interface DTOs) silently disables the platform's global valida |
| APA-077 | LOW | ⏳ pending | [modules](findings/modules.md) | (cross-cutting) | FE double-submit CSRF header has no server-side counterpart in admin-api |
| APA-078 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | BillingDashboardPage | Five of nine dashboard metrics are hardcoded null and render permanent N/A |
| APA-079 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | BillingDashboardPage | Export Report button and Revenue Trend chart are dead UI |
| APA-080 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | BillingDashboardPage | Recent Transactions swallows all errors and shows empty state on 500 |
| APA-081 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | BillingDashboardPage | Invoice statuses 'sent'/'draft'/'partially_paid'/'overdue' all misrender as 'failed' transactions |
| APA-082 | HIGH | ✅ designed | [billing-core](findings/billing-core.md) | InvoicesPage | Admin-created invoices are stuck in 'draft' forever — no finalize path, cannot be marked paid |
| APA-083 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | InvoicesPage | No pagination — list hard-capped at 100 invoices with no offset controls |
| APA-084 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | InvoicesPage | Search fires a full list+stats refetch on every keystroke with no debounce |
| APA-085 | LOW | ✅ designed | [billing-core](findings/billing-core.md) | InvoicesPage | Void offered for partially_paid invoices but backend always rejects it |
| APA-086 | LOW | ✅ designed | [billing-core](findings/billing-core.md) | InvoicesPage | MarkInvoicePaidDto accepts amount 0, creating a $0 payment that flips status to partially_paid |
| APA-087 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | PaymentsPage | Invoice-ID filter throws 500 on every keystroke of a non-UUID value |
| APA-088 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | PaymentsPage | Refund history is never returned — payment detail modal's Refund History section is permanently dead |
| APA-089 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | PaymentsPage | Stat cards (Succeeded/Refunded/Net) computed from the current 50-row page while Total Payments is th |
| APA-090 | LOW | ✅ designed | [billing-core](findings/billing-core.md) | PaymentsPage | FE PaymentOverview type omits invoiceNumber; page reads it through an inline cast |
| APA-091 | HIGH | ✅ designed | [billing-core](findings/billing-core.md) | BillingReportsPage | 'Payments With Refunds' metric is structurally always ~0; 'Successful Payments' shrinks when payment |
| APA-092 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | BillingReportsPage | Refund count additionally capped at 100 rows and export is summary-only |
| APA-093 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | (cross-cutting) | Admin billing reads ignore soft-delete: is_deleted rows counted in invoice lists/stats, payment list |
| APA-094 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | (cross-cutting) | Financial mutation endpoints use interface-typed @Body DTOs, silently bypassing the global Validatio |
| APA-095 | MEDIUM | ✅ designed | [billing-core](findings/billing-core.md) | (cross-cutting) | Multi-currency amounts are summed into single totals and always rendered as USD |
| APA-096 | LOW | ✅ designed | [billing-core](findings/billing-core.md) | (cross-cutting) | FE double-submit CSRF token is decorative — admin-api never sets or verifies XSRF-TOKEN |
| APA-097 | LOW | ✅ designed | [billing-core](findings/billing-core.md) | (cross-cutting) | Positive verification: auth, routing and envelope chain are sound for this section |
| APA-098 | MEDIUM | ✅ designed | [billing-plans](findings/billing-plans.md) | SubscriptionManagementPage | Process Renewals button always fails, silently |
| APA-099 | NOT_A_BUG | ❌ refuted | [billing-plans](findings/billing-plans.md) | SubscriptionManagementPage | monthlyPrice column shows per-cycle price labeled as '/mo' |
| APA-100 | MEDIUM | ✅ designed | [billing-plans](findings/billing-plans.md) | SubscriptionManagementPage | Cancel leaves status 'active' — UI appears to have failed |
| APA-101 | LOW | ✅ designed | [billing-plans](findings/billing-plans.md) | SubscriptionManagementPage | Search refetches subscriptions+stats on every keystroke |
| APA-102 | HIGH | ✅ designed | [billing-plans](findings/billing-plans.md) | PlanManagementPage | 'Create New Plan' button has no handler — plan create/update never wired |
| APA-103 | MEDIUM | ✅ designed | [billing-plans](findings/billing-plans.md) | PlanManagementPage | POST/PUT /billing/plans bodies are completely unvalidated |
| APA-104 | LOW | ✅ designed | [billing-plans](findings/billing-plans.md) | PlanManagementPage | FE PlanLimits type drifts from backend PlanLimits |
| APA-105 | LOW | ✅ designed | [billing-plans](findings/billing-plans.md) | PlanManagementPage | console.error used (banned by repo lint rules) |
| APA-106 | CRITICAL | ✅ designed | [billing-plans](findings/billing-plans.md) | DiscountCodePage | Discount code table is always empty — triple envelope/shape mismatch |
| APA-107 | MEDIUM | ✅ designed | [billing-plans](findings/billing-plans.md) | DiscountCodePage | Generate->Create silently mutates the code (underscore stripped) |
| APA-108 | MEDIUM | ✅ designed | [billing-plans](findings/billing-plans.md) | DiscountCodePage | applyDiscount redemption counting is not atomic |
| APA-109 | LOW | ✅ designed | [billing-plans](findings/billing-plans.md) | DiscountCodePage | List capped at 50 codes with no pagination UI |
| APA-110 | LOW | ✅ designed | [billing-plans](findings/billing-plans.md) | DiscountCodePage | getDiscountRedemptions FE contract mismatch (unused endpoint) |
| APA-111 | MEDIUM | ✅ designed | [billing-plans](findings/billing-plans.md) | ModulePricingPage | pricingMetrics accepted with only @IsArray — no element validation |
| APA-112 | LOW | ⏳ pending | [billing-plans](findings/billing-plans.md) | ModulePricingPage | Every save creates a new version row with effectiveFrom=now; currency/effectiveFrom dropped from pay |
| APA-113 | HIGH | ✅ designed | [billing-plans](findings/billing-plans.md) | CustomPlansListPage | Activate always throws 409 — approval workflow dead-ends before subscription creation |
| APA-114 | HIGH | ✅ designed | [billing-plans](findings/billing-plans.md) | CustomPlansListPage | Status/search/tier filters return 400 Bad Request |
| APA-115 | MEDIUM | ⏳ pending | [billing-plans](findings/billing-plans.md) | CustomPlansListPage | FE CustomPlanStatus.CANCELLED does not exist in the backend |
| APA-116 | LOW | ⏳ pending | [billing-plans](findings/billing-plans.md) | CustomPlansListPage | Clone copies stale approval artifacts |
| APA-117 | MEDIUM | ⏳ pending | [billing-plans](findings/billing-plans.md) | CustomPlanBuilderPage | Silent client-side pricing fallback with hardcoded multipliers |
| APA-118 | MEDIUM | ⏳ pending | [billing-plans](findings/billing-plans.md) | CustomPlanBuilderPage | POST /billing/pricing/calculate and /billing/custom-plans bodies unvalidated |
| APA-119 | LOW | ⏳ pending | [billing-plans](findings/billing-plans.md) | CustomPlanBuilderPage | Raw icon names rendered instead of emoji |
| APA-120 | LOW | ⏳ pending | [billing-plans](findings/billing-plans.md) | CustomPlanBuilderPage | Hardcoded discount claims in tier/cycle selectors |
| APA-121 | HIGH | ✅ designed | [billing-plans](findings/billing-plans.md) | UsageDashboardPage | Usage metering has no ingestion source — dashboard is permanently empty |
| APA-122 | MEDIUM | ⏳ pending | [billing-plans](findings/billing-plans.md) | UsageDashboardPage | getUsageSummary swallows DB errors and returns zeros |
| APA-123 | MEDIUM | ⏳ pending | [billing-plans](findings/billing-plans.md) | UsageDashboardPage | 'Metered Billing Pricing Tiers' panel is hardcoded static content |
| APA-124 | LOW | ⏳ pending | [billing-plans](findings/billing-plans.md) | UsageDashboardPage | tenantName never populated — rows show truncated UUIDs |
| APA-125 | LOW | ⏳ pending | [billing-plans](findings/billing-plans.md) | UsageDashboardPage | getAllTenantsUsage issues N+1 queries |
| APA-126 | HIGH | ✅ designed | [billing-plans](findings/billing-plans.md) | (cross-cutting) | Two disconnected plan catalogs: admin.plan_definitions is never enforced at subscription time |
| APA-127 | HIGH | ✅ designed | [billing-plans](findings/billing-plans.md) | (cross-cutting) | Discount codes are never applied in any real revenue flow |
| APA-128 | MEDIUM | ⏳ pending | [billing-plans](findings/billing-plans.md) | (cross-cutting) | Service-exported interface 'DTOs' bypass the global ValidationPipe across the billing surface |
| APA-129 | MEDIUM | ⏳ pending | [billing-plans](findings/billing-plans.md) | (cross-cutting) | Unmanaged envelope/pagination contract between ResponseInterceptor and hand-written FE types |
| APA-130 | HIGH | ✅ designed | [analytics](findings/analytics.md) | AnalyticsDashboardPage | All three trend charts 500 once snapshot data exists — Date methods called on TypeORM 'date' column  |
| APA-131 | HIGH | ✅ designed | [analytics](findings/analytics.md) | AnalyticsDashboardPage | System Metrics card and API-call KPIs are fabricated constants presented as live data |
| APA-132 | HIGH | ✅ designed | [analytics](findings/analytics.md) | AnalyticsDashboardPage | 'Bolgesel Dagilim' (regional distribution) is fabricated — every tenant hardcoded to TR |
| APA-133 | HIGH | ✅ designed | [analytics](findings/analytics.md) | AnalyticsDashboardPage | Module Usage / Feature Adoption cards render placeholder zeros as real usage data |
| APA-134 | MEDIUM | ⏳ pending | [analytics](findings/analytics.md) | AnalyticsDashboardPage | KPI trend indicators hardcoded — negative growth renders as green up-arrow; churn delta is a literal |
| APA-135 | MEDIUM | ⏳ pending | [analytics](findings/analytics.md) | AnalyticsDashboardPage | churnedThisMonth/churnRate proxy is wrong: any update to an already-suspended tenant re-counts it as |
| APA-136 | MEDIUM | ⏳ pending | [analytics](findings/analytics.md) | AnalyticsDashboardPage | Total API failure renders an all-zero dashboard with no error indication |
| APA-137 | LOW | ⏳ pending | [analytics](findings/analytics.md) | AnalyticsDashboardPage | Period selector (7d/30d/90d/1y) only affects the three trend charts; every KPI stays fixed to 'this  |
| APA-138 | HIGH | ✅ designed | [analytics](findings/analytics.md) | ReportsPage | financial_payments report fabricates invoice records — status is a tautology that is always 'paid';  |
| APA-139 | HIGH | ✅ designed | [analytics](findings/analytics.md) | ReportsPage | financial_revenue report synthesizes revenue from hardcoded plan prices and current tenant status, i |
| APA-140 | MEDIUM | ✅ designed | [analytics](findings/analytics.md) | ReportsPage | Date-range picker is a silent no-op for 5 of 7 report types |
| APA-141 | LOW | ✅ designed | [analytics](findings/analytics.md) | ReportsPage | Scheduled reports have no scheduler — schedule and recipients are stored and never acted on |
| APA-142 | HIGH | ✅ designed | [analytics](findings/analytics.md) | ReportsPage | usage_modules and usage_features reports contain placeholder zeros generated 'successfully' |
| APA-143 | HIGH | ✅ designed | [analytics](findings/analytics.md) | ReportsPage | system_performance report fabricates per-day metrics when no snapshots exist (45ms / 0.1% / 99.9% ha |
| APA-144 | MEDIUM | ✅ designed | [analytics](findings/analytics.md) | ReportsPage | Report 'View' preview can never show row data — data field is never populated |
| APA-145 | MEDIUM | ⏳ pending | [analytics](findings/analytics.md) | ReportsPage | Generator errors are swallowed into 'completed' executions with empty data |
| APA-146 | MEDIUM | ⏳ pending | [analytics](findings/analytics.md) | ReportsPage | ReportResult.downloadUrl from POST /reports/generate is a dead link |
| APA-147 | MEDIUM | ⏳ pending | [analytics](findings/analytics.md) | ReportsPage | Hardcoded plan-price table duplicated 4x in ReportsService, diverging from billing.subscriptions pri |
| APA-148 | LOW | ⏳ pending | [analytics](findings/analytics.md) | ReportsPage | Report history capped at first 20 executions with no pagination UI |
| APA-149 | MEDIUM | ✅ designed | [analytics](findings/analytics.md) | (cross-cutting) | Hand-written FE analytics types drift from actual backend response shapes on ~10 endpoints — consume |
| APA-150 | MEDIUM | ⏳ pending | [analytics](findings/analytics.md) | (cross-cutting) | FE ReportDefinition contract drift: createReportDefinition payload would be 400-rejected by forbidNo |
| APA-151 | MEDIUM | ⏳ pending | [analytics](findings/analytics.md) | (cross-cutting) | Dead FE API functions throw synchronously ('Not implemented') — landmines for any future caller |
| APA-152 | LOW | ⏳ pending | [analytics](findings/analytics.md) | (cross-cutting) | X-CSRF-Token double-submit machinery is decorative for admin-api — no server-side check, cookie neve |
| APA-153 | LOW | ⏳ pending | [analytics](findings/analytics.md) | (cross-cutting) | Routing, guard, envelope, schema and storage plumbing verified sound (positive assurance) |
| APA-154 | LOW | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingMonitoringPage | Dead FE API function for monitoring stats |
| APA-155 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingTenantsPage | Export artifact is generated then thrown away — no persistence, no download path |
| APA-156 | MEDIUM | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingTenantsPage | Synchronous full-tenant export inside a 15s NATS request-reply; FE retries 504 and re-runs the whole |
| APA-157 | LOW | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingTenantsPage | 202 Accepted + 'runs asynchronously' UI text contradict the synchronous 'completed' status |
| APA-158 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAuditPage | Default page load always fails: tenantId is required by the backend but optional/empty in the FE |
| APA-159 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAuditPage | Response envelope shape mismatch crashes the page when a valid tenant is queried |
| APA-160 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAuditPage | Field-level drift: FE MessagingAuditEntry does not match ComplianceAuditLog rows |
| APA-161 | MEDIUM | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAuditPage | Offset pagination UI over a cursor-based backend — page navigation is a no-op |
| APA-162 | MEDIUM | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAuditPage | Action filter vocabulary mismatch — every filtered query returns zero rows |
| APA-163 | CRITICAL | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingCompliancePage | Legal-hold release is impossible from the admin panel — dual-approver fields are dropped by the whol |
| APA-164 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingCompliancePage | Both primary GETs always fail: page omits tenantId, backend fail-closes without a tenant UUID |
| APA-165 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingCompliancePage | ComplianceStats contract drift: 4 of 7 FE fields never exist; a successful response would crash the  |
| APA-166 | MEDIUM | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingCompliancePage | LegalHold rows lack tenantName/channelName the table renders; channel-scoped holds would display as  |
| APA-167 | MEDIUM | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingCompliancePage | Fabricated 'Compliance Score 100%' rendered while the backend fetch fails |
| APA-168 | MEDIUM | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingCompliancePage | Create-legal-hold chain fully implemented backend-to-DB but unreachable — no UI invokes it |
| APA-169 | LOW | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingCompliancePage | Exports table, retention buckets, and daily-audit chart are hardcoded empty locals |
| APA-170 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingRetentionPage | Retention policy update contract is triple-mismatched — edits never persist |
| APA-171 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingRetentionPage | Policy list can never load: FE API has no tenantId parameter, backend requires one |
| APA-172 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingRetentionPage | Response shape drift would crash the table if rows ever arrived |
| APA-173 | MEDIUM | ⏳ pending | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingRetentionPage | 'Add Channel Override' modal is a silent no-op |
| APA-174 | LOW | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingRetentionPage | Hardcoded 'Next cleanup: 02:00 UTC' chip |
| APA-175 | LOW | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAiDashboardPage | Static claims about backend infrastructure are unverifiable and can silently rot |
| APA-176 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAiPersonasPage | LIFE-SAFETY state is presented as live backend data but is entirely hardcoded |
| APA-177 | MEDIUM | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAiPersonasPage | Mandatory tenant UUID input has zero effect — backend registry ignores tenantId |
| APA-178 | LOW | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | MessagingAiPersonasPage | '+ Add Custom Persona' button opens a future-release placeholder |
| APA-179 | MEDIUM | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | (cross-cutting) | All messaging-admin DTOs are TypeScript interfaces — the global ValidationPipe never runs on these e |
| APA-180 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | (cross-cutting) | NATS error translation collapses deterministic domain 4xx failures into retryable 502s — FE retry st |
| APA-181 | HIGH | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | (cross-cutting) | No cross-tenant capability behind a cross-tenant UI: every messaging admin read is strictly single-t |
| APA-182 | MEDIUM | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | (cross-cutting) | Hand-written FE types systematically expect enrichment (tenantName/userName/channelName) that no lay |
| APA-183 | MEDIUM | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | (cross-cutting) | Documented DB-level dual-approver CHECK constraint is missing from the active migration ledger |
| APA-184 | LOW | ✅ designed | [messaging-monitoring](findings/messaging-monitoring.md) | (cross-cutting) | Auth/guard chain and schema discipline are correct across the section |
| APA-185 | CRITICAL | ✅ designed | [support](findings/support.md) | TicketsPage | Ticket assignment always 500s: authorId 'system' inserted into uuid NOT NULL column |
| APA-186 | HIGH | ✅ designed | [support](findings/support.md) | TicketsPage | POST /support/tickets always 500s: hardcoded createdBy 'tenant-user-id' into uuid NOT NULL column |
| APA-187 | HIGH | ✅ designed | [support](findings/support.md) | TicketsPage | Ticket comments never display: paginated backend response mapped as an array by the FE |
| APA-188 | HIGH | ✅ designed | [support](findings/support.md) | TicketsPage | Any status/priority/category filter selection makes GET /support/tickets return 400 |
| APA-189 | MEDIUM | ✅ designed | [support](findings/support.md) | TicketsPage | Ticket numbers generated from an in-memory counter: guaranteed unique-constraint collision after ser |
| APA-190 | MEDIUM | ✅ designed | [support](findings/support.md) | TicketsPage | Internal notes and system status-change comments count as SLA 'first response' |
| APA-191 | MEDIUM | ✅ designed | [support](findings/support.md) | TicketsPage | FE contract drift on stats/by-category, stats/by-priority, sla-risk and satisfaction endpoints |
| APA-192 | MEDIUM | ✅ designed | [support](findings/support.md) | TicketsPage | All mutation failures swallowed with console.error; no user feedback or rollback |
| APA-193 | LOW | ✅ designed | [support](findings/support.md) | TicketsPage | commentCount hardcoded to 0 in the ticket list |
| APA-194 | HIGH | ✅ designed | [support](findings/support.md) | MessagingPage | Bulk Message always fails with 400 'No target tenants specified' |
| APA-195 | HIGH | ✅ designed | [support](findings/support.md) | MessagingPage | Thread summary field drift zeroes unread badges and hides closed state, enabling silent 400s on send |
| APA-196 | MEDIUM | ✅ designed | [support](findings/support.md) | MessagingPage | Internal Note toggle is decorative: isInternal never sent, notes go out as public messages |
| APA-197 | MEDIUM | ✅ designed | [support](findings/support.md) | MessagingPage | Admin messages misrendered as inbound: FE checks senderType 'super_admin' but backend stores 'admin' |
| APA-198 | MEDIUM | ✅ designed | [support](findings/support.md) | MessagingPage | Thread list tenant name always 'Unknown Tenant' |
| APA-199 | MEDIUM | ✅ designed | [support](findings/support.md) | MessagingPage | New Conversation takes free-text Tenant ID: non-UUID input 500s, no tenant existence check |
| APA-200 | LOW | ✅ designed | [support](findings/support.md) | MessagingPage | New thread double-counts the first message as unread (unreadTenantCount = 2) |
| APA-201 | CRITICAL | ✅ designed | [support](findings/support.md) | AnnouncementsPage | Announcements are stored but never delivered: tenants read a different table in a different service |
| APA-202 | HIGH | ✅ designed | [support](findings/support.md) | AnnouncementsPage | View/acknowledgment tracking is dead: recording endpoints are SUPER_ADMIN-only, so counts stay 0 for |
| APA-203 | HIGH | ✅ designed | [support](findings/support.md) | AnnouncementsPage | 'Targeted' announcements cannot be created: UI collects no targetCriteria, backend rejects with 400, |
| APA-204 | MEDIUM | ✅ designed | [support](findings/support.md) | AnnouncementsPage | Edit button on drafts opens the Stats modal; no edit path exists |
| APA-205 | MEDIUM | ✅ designed | [support](findings/support.md) | AnnouncementsPage | Publish/cancel/delete failures are silent |
| APA-206 | LOW | ✅ designed | [support](findings/support.md) | AnnouncementsPage | FE AnnouncementType includes 'success' which the backend does not support |
| APA-207 | HIGH | ✅ designed | [support](findings/support.md) | OnboardingPage | Onboarding progress does not read real tenant activity and is never initialized automatically |
| APA-208 | HIGH | ✅ designed | [support](findings/support.md) | OnboardingPage | Field drift blanks the core renders: 'undefined% complete', empty step names, dead Needs-Attention f |
| APA-209 | HIGH | ✅ designed | [support](findings/support.md) | OnboardingPage | Stats header shows 'Total Tenants: NaN' — backend has no 'stalled' bucket |
| APA-210 | MEDIUM | ✅ designed | [support](findings/support.md) | OnboardingPage | Training resources and step tutorial links are hardcoded with dead URLs |
| APA-211 | MEDIUM | ✅ designed | [support](findings/support.md) | OnboardingPage | sendWelcomeEmail returns fake success: no email is ever sent but welcomeEmailSent is persisted true |
| APA-212 | LOW | ✅ designed | [support](findings/support.md) | OnboardingPage | Skipping a required step throws a plain Error -> 500 instead of 400 |
| APA-213 | CRITICAL | ✅ designed | [support](findings/support.md) | (cross-cutting) | Split-brain support architecture: admin panel and tenants operate on two disconnected persistence si |
| APA-214 | HIGH | ✅ designed | [support](findings/support.md) | (cross-cutting) | Abandoned mid-migration: correct GraphQL hooks exist in admin-panel but no support page uses them |
| APA-215 | HIGH | ✅ designed | [support](findings/support.md) | (cross-cutting) | Every outbound notification path in the support module is an unimplemented TODO that reports success |
| APA-216 | MEDIUM | ✅ designed | [support](findings/support.md) | (cross-cutting) | Guard posture verified sound; schema/migration parity verified sound (no finding — audit confirmatio |
| APA-217 | HIGH | ✅ designed | [security](findings/security.md) | ActivityLogPage | Activity ledger has zero writers — page is permanent false assurance |
| APA-218 | MEDIUM | ✅ designed | [security](findings/security.md) | ActivityLogPage | 'Unique Users' / 'Unique IPs' stat cards are silently capped at 10 |
| APA-219 | MEDIUM | ⏳ pending | [security](findings/security.md) | ActivityLogPage | 'Avg Response' metric hardcoded to 0ms and rendered as a real stat |
| APA-220 | MEDIUM | ⏳ pending | [security](findings/security.md) | ActivityLogPage | ORDER BY built from unvalidated sortBy query param |
| APA-221 | MEDIUM | ⏳ pending | [security](findings/security.md) | ActivityLogPage | Export button only dumps the current 50-row page client-side |
| APA-222 | MEDIUM | ⏳ pending | [security](findings/security.md) | ActivityLogPage | securityApi.getUserActivities targets a nonexistent route (404) |
| APA-223 | LOW | ⏳ pending | [security](findings/security.md) | ActivityLogPage | FE type invents fields the entity never returns (userAgent, location, timestamp) |
| APA-224 | HIGH | ✅ designed | [security](findings/security.md) | AuditTrailPage | Action filter can never match: lowercase FE values vs UPPERCASE backend enum |
| APA-225 | HIGH | ✅ designed | [security](findings/security.md) | AuditTrailPage | Alert Rules tab is decorative: in-memory rules, evaluation never runs, channels are stubs |
| APA-226 | MEDIUM | ⏳ pending | [security](findings/security.md) | AuditTrailPage | DB errors render as clean empty audit data |
| APA-227 | MEDIUM | ⏳ pending | [security](findings/security.md) | AuditTrailPage | Add/Edit/Delete buttons for retention policies and alert rules have no handlers |
| APA-228 | MEDIUM | ⏳ pending | [security](findings/security.md) | AuditTrailPage | Retention Policies tab governs a table the page never shows (and one with no writers) |
| APA-229 | LOW | ⏳ pending | [security](findings/security.md) | AuditTrailPage | 'Total Entries' is actually a 30-day count |
| APA-230 | LOW | ⏳ pending | [security](findings/security.md) | AuditTrailPage | Alert-rule card renders Invalid Date and fake trigger count |
| APA-231 | HIGH | ✅ designed | [security](findings/security.md) | CompliancePage | Typing in the search box 400s the whole data-request list |
| APA-232 | HIGH | ✅ designed | [security](findings/security.md) | CompliancePage | Compliance Checks tab crashes: backend returns requirement as an OBJECT, page renders it as a React  |
| APA-233 | HIGH | ⏳ pending | [security](findings/security.md) | CompliancePage | Reports 'Key Findings' has the same object-render crash — and monthly cron guarantees reports exist |
| APA-234 | HIGH | ⏳ pending | [security](findings/security.md) | CompliancePage | All five compliance stat cards are hardcoded zeros while a real stats endpoint sits unused |
| APA-235 | MEDIUM | ⏳ pending | [security](findings/security.md) | CompliancePage | GET data-requests/stats is route-shadowed by data-requests/:id |
| APA-236 | MEDIUM | ⏳ pending | [security](findings/security.md) | CompliancePage | Status filter offers states the backend does not have |
| APA-237 | MEDIUM | ⏳ pending | [security](findings/security.md) | CompliancePage | Expired GDPR download URLs are never actually cleared |
| APA-238 | MEDIUM | ⏳ pending | [security](findings/security.md) | CompliancePage | Generate Report / Download / Run Assessment buttons are dead |
| APA-239 | LOW | ⏳ pending | [security](findings/security.md) | CompliancePage | Non-GDPR frameworks silently reuse the GDPR requirement set; dead broken Not() helper |
| APA-240 | CRITICAL | ✅ designed | [security](findings/security.md) | SecurityDashboardPage | Threat-detection supply chain is dead — dashboard always reports 100/'healthy' (false assurance) |
| APA-241 | MEDIUM | ⏳ pending | [security](findings/security.md) | SecurityDashboardPage | 'Critical (24h)' and 'Blocked (24h)' cards actually show all-time counts |
| APA-242 | MEDIUM | ⏳ pending | [security](findings/security.md) | SecurityDashboardPage | Incident field drift: FE reads columns the entity does not have |
| APA-243 | MEDIUM | ⏳ pending | [security](findings/security.md) | SecurityDashboardPage | 'Affected Tenants' hardcoded 0; 'Unique IPs' capped at 10 |
| APA-244 | LOW | ⏳ pending | [security](findings/security.md) | SecurityDashboardPage | Status/search filters exist as dead state; resolved-count only scans first incident page |
| APA-245 | CRITICAL | ⏳ pending | [security](findings/security.md) | (cross-cutting) | Admin security telemetry ledgers have no producers anywhere in the platform |
| APA-246 | HIGH | ✅ designed | [security](findings/security.md) | (cross-cutting) | Security alerting/notification layer is stubbed end-to-end |
| APA-247 | MEDIUM | ⏳ pending | [security](findings/security.md) | (cross-cutting) | Actor attribution hardcoded to 'admin' on audit-relevant mutations |
| APA-248 | MEDIUM | ⏳ pending | [security](findings/security.md) | (cross-cutting) | Hand-written FE response types drift systematically (no codegen) |
| APA-249 | MEDIUM | ⏳ pending | [security](findings/security.md) | (cross-cutting) | Unvalidated sortBy interpolated into ORDER BY in two query builders |
| APA-250 | LOW | ⏳ pending | [security](findings/security.md) | (cross-cutting) | PDF export is a plaintext placeholder served as application/pdf |
| APA-251 | CRITICAL | ✅ designed | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | Feature-toggle switch (FeatureTogglesPage primary action) calls a route that does not exist on the b |
| APA-252 | HIGH | ✅ designed | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | docker-compose.prod.yml stack routes /api/ to gateway-api, which has no admin proxy — entire admin p |
| APA-253 | HIGH | ✅ designed | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | No dev-mode route to admin-api: shell vite has no /api proxy and the default/dev compose stacks have |
| APA-254 | HIGH | ⏳ pending | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | 19 additional admin-panel API functions target routes that do not exist (or wrong method) on admin-a |
| APA-255 | HIGH | ⏳ pending | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | 10 mounted admin routes are unreachable: no sidebar entry and no in-page link (7 messaging pages, pr |
| APA-256 | MEDIUM | ⏳ pending | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | Duplicate, already-drifted navigation SSoT: admin-panel's AdminLayout/admin-nav-items are dead code; |
| APA-257 | MEDIUM | ⏳ pending | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | CSRF double-submit is inert platform-wide: XSRF-TOKEN cookie is never issued and X-CSRF-Token is nev |
| APA-258 | MEDIUM | ⏳ pending | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | Validation-error detail is lost end-to-end: ValidationPipe's message array is dropped by the FE erro |
| APA-259 | LOW | ⏳ pending | [xc-routing-nav](findings/xc-routing-nav.md) | (cross-cutting) | Response envelope parity verified, with two structural fragilities in the pagination heuristic |
| APA-260 | CRITICAL | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | FeatureTogglesPage | Enable/Disable button calls POST feature-toggles/:id/toggle which has no backend route (404) |
| APA-261 | HIGH | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | FeatureTogglesPage | Edit form always 400s: FE sends scope and isExperimental but UpdateFeatureToggleDto does not whiteli |
| APA-262 | HIGH | ✅ designed | [system-mgmt](findings/system-mgmt.md) | FeatureTogglesPage | Feature toggles are persisted but consumed by nothing - no gating code exists anywhere |
| APA-263 | MEDIUM | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | FeatureTogglesPage | evaluateFeature FE contract mismatched with backend (key in query vs body) - would 400 if ever used |
| APA-264 | LOW | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | FeatureTogglesPage | No pagination UI despite server-side pagination (default limit 50) - toggles beyond 50 are invisible |
| APA-265 | HIGH | ✅ designed | [system-mgmt](findings/system-mgmt.md) | MaintenancePage | Maintenance list is always empty: FE expects a bare array but receives {items,total} |
| APA-266 | HIGH | ✅ designed | [system-mgmt](findings/system-mgmt.md) | MaintenancePage | Schedule Maintenance always 400s: payload includes createdBy which CreateMaintenanceDto does not whi |
| APA-267 | HIGH | ✅ designed | [system-mgmt](findings/system-mgmt.md) | MaintenancePage | Maintenance mode blocks nothing - checkMaintenanceMode has zero consumers |
| APA-268 | HIGH | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | MaintenancePage | Edit modal submits via handleCreate - updates are silently turned into duplicate creations |
| APA-269 | HIGH | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | PerformanceDashboardPage | Application metrics have no producer - response time/error rate/throughput/apdex are permanently zer |
| APA-270 | HIGH | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | PerformanceDashboardPage | 'Infrastructure Metrics' are the admin-api container's own OS stats presented as platform infrastruc |
| APA-271 | MEDIUM | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | PerformanceDashboardPage | Time-range selector is a silent no-op: FE sends start/end, backend reads startDate/endDate |
| APA-272 | MEDIUM | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | PerformanceDashboardPage | Health probes hardcode droplet docker hostnames; charts are an explicit placeholder |
| APA-273 | LOW | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | PerformanceDashboardPage | When no snapshot exists the FE fabricates healthScore 100 / apdex 1 defaults |
| APA-274 | CRITICAL | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | ErrorTrackingPage | No error ingestion exists: POST /system/errors/report has zero callers and is blocked for services b |
| APA-275 | CRITICAL | ✅ designed | [system-mgmt](findings/system-mgmt.md) | ErrorTrackingPage | Page crashes on any successful load once data exists: reads .data from an {items,total} response |
| APA-276 | HIGH | ✅ designed | [system-mgmt](findings/system-mgmt.md) | ErrorTrackingPage | Acknowledge action 404s (route mismatch) and Resolve action 400s (non-whitelisted body field); both  |
| APA-277 | MEDIUM | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | ErrorTrackingPage | Dashboard stat drift: FE reads unresolvedErrors/criticalErrors which the backend never returns |
| APA-278 | MEDIUM | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | ErrorTrackingPage | Alert-rule notification actions are log-only stubs (email/slack/webhook never sent) |
| APA-279 | HIGH | ✅ designed | [system-mgmt](findings/system-mgmt.md) | JobQueuePage | Jobs list is always empty: getJobs reads response.data from an {items,total} payload and the guard s |
| APA-280 | HIGH | ✅ designed | [system-mgmt](findings/system-mgmt.md) | JobQueuePage | The queue executes nothing: no job handler is ever registered and no platform component enqueues int |
| APA-281 | HIGH | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | JobQueuePage | Dashboard shape drift empties the Queues tab and blanks stats: FE expects queues/failedToday, backen |
| APA-282 | MEDIUM | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | JobQueuePage | Route shadowing and a wrong stat: /jobs/scheduled and /jobs/failed resolve to GET :id; completedLast |
| APA-283 | CRITICAL | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | (cross-cutting) | Systemic paginated-response contract break: backend {items,total} vs FE PaginatedResult {data,...} k |
| APA-284 | CRITICAL | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | (cross-cutting) | Telemetry ingestion endpoints are architecturally unreachable: SUPER_ADMIN user-JWT guard on service |
| APA-285 | HIGH | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | (cross-cutting) | Control-plane theater: feature toggles, maintenance mode, and the job queue all persist real rows th |
| APA-286 | MEDIUM | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | (cross-cutting) | contract-validation.spec.ts KNOWN_DRIFT allowlist masks live breakage and contains stale/incorrect r |
| APA-287 | LOW | ⏳ pending | [system-mgmt](findings/system-mgmt.md) | (cross-cutting) | Schema/migration discipline is correct for this module (verified, no finding) |
| APA-288 | CRITICAL | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | DB append-only trigger on impersonation_sessions makes every session-lifecycle mutation fail (end/te |
| APA-289 | CRITICAL | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | Impersonation access chain is not wired end-to-end: the issued token is discarded and nothing can co |
| APA-290 | HIGH | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | Revoke Permission always 404s: FE sends the permission row id where the route requires superAdminId |
| APA-291 | HIGH | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | Permissions tab crashes / renders undefined on real data: FE ImpersonationPermission type shares alm |
| APA-292 | HIGH | ⏳ pending | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | 'View Actions' always shows an empty audit trail even when actions exist |
| APA-293 | HIGH | ⏳ pending | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | No separation of duties: a SUPER_ADMIN self-grants impersonation permission, and nothing prevents im |
| APA-294 | HIGH | ⏳ pending | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | Audit-write failures are silently swallowed despite in-code claims that they propagate (AUDITTRAIL-C |
| APA-295 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | End/Extend failures are swallowed silently, and the operator-override Terminate flow is unreachable  |
| APA-296 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | Grant form drift: duration input allows 15-480 min vs backend @Max(60), and 'Allowed Actions' checkb |
| APA-297 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | Stats mislabeled and aggregates truncated to first 20 sessions (no pagination) |
| APA-298 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | GET /impersonation/permissions?tenantId=... 500s: ANY() applied to a jsonb column |
| APA-299 | LOW | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | targetTenantName is client-supplied and stored unverified into the session/audit record |
| APA-300 | LOW | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | ImpersonationPage | Top-admins emails render 'Unknown' going forward (H-08 removed email from JWT) |
| APA-301 | HIGH | ⏳ pending | [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | Entire /debug backend is unreachable as deployed: module disabled by default (ENABLE_DEBUG_TOOLS uns |
| APA-302 | HIGH | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | Cache management is a placebo even when enabled: all invalidation paths are logger no-ops, and the F |
| APA-303 | HIGH | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | Cache entries/stats are DB snapshots that nothing ever writes, with a fabricated hit-rate formula —  |
| APA-304 | HIGH | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | 'Active Connections' table is fabricated in the FE: hardcoded database/user/application/state values |
| APA-305 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | Log Viewer and Config Viewer tabs are client-side TODO stubs (NOT_WIRED features shipped in the UI) |
| APA-306 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | SQL Query Executor is a facade: warns about executing on the production database, then always throws |
| APA-307 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | Route-declaration-order shadowing in DebugToolsController makes two endpoints unreachable |
| APA-308 | LOW | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | DebugToolsPage | Cache key is URL-decoded twice (FE encode -> Express decode -> controller decodeURIComponent) |
| APA-309 | HIGH | ⏳ pending | [impersonation-debug](findings/impersonation-debug.md) | (cross-cutting) | Platform audit trail is best-effort by construction: AuditLogService.log swallows every persistence  |
| APA-310 | HIGH | ⏳ pending | [impersonation-debug](findings/impersonation-debug.md) | (cross-cutting) | DB immutability triggers were applied to an operational (mutable-lifecycle) table, not just audit ta |
| APA-311 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | (cross-cutting) | Hand-written FE types with no codegen have drifted to the point of conceptual inversion |
| APA-312 | MEDIUM | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | (cross-cutting) | Backend feature availability (env flags, nginx blocks) is invisible to the admin-panel: pages ship f |
| APA-313 | LOW | ✅ designed | [impersonation-debug](findings/impersonation-debug.md) | (cross-cutting) | NestJS static-segment routes declared after parameterized siblings are shadowed — recurring pattern  |
| APA-314 | CRITICAL | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Create Backup always fails with 400 — FE sends 'encrypt' field the DTO does not whitelist |
| APA-315 | HIGH | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Backups can never actually complete in the deployed container — pg_dump binary, /backups volume, and |
| APA-316 | HIGH | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Restore from backup always fails — runtime restore is disabled at the authority boundary but the FE  |
| APA-317 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Suspend/Activate schema buttons silently do nothing — backend always throws 409 and FE has no .catch |
| APA-318 | HIGH | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Slow Queries panel can never display data — backend returns a SlowQueryResult object, FE expects an  |
| APA-319 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Database Health 'Slow Queries' check uses an inverted time filter — counts everything EXCEPT the las |
| APA-320 | HIGH | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Validate Isolation always reports 'Issues found' — field name drift (isIsolated vs valid) |
| APA-321 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Backup Schedule card always shows 'Not configured' + suspended — response shape drift |
| APA-322 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Point-in-Time Recovery modal is not wired — inputs are dead and the API is never called |
| APA-323 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Migrations tab is vestigial — registry is permanently empty and all run/rollback/batch endpoints unc |
| APA-324 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Index Recommendations render an empty SQL block — backend has no createStatement field |
| APA-325 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | Schemas tab stats may be stale/zero — tenant_schemas sizeBytes/tableCount are ledger columns with no |
| APA-326 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseManagementPage.tsx | FE api layer declares ~14 endpoints that do not exist on the backend (404 if ever used) plus hand-wr |
| APA-327 | HIGH | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | CSV/JSON export downloads a JSON envelope, not the data — global ResponseInterceptor wraps the Strea |
| APA-328 | HIGH | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | Edit Row writes the '********' mask back into real sensitive columns when writes are enabled |
| APA-329 | HIGH | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | Explorer read/export/raw-SQL audit rows record performedBy:'SUPER_ADMIN' literal instead of the actu |
| APA-330 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | insert/update responses return the raw RETURNING * row unmasked |
| APA-331 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | Write UI (New Row / Edit / Delete) is always rendered but always 403 in production |
| APA-332 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | Raw SQL endpoint returns rows unmasked and its catalog blocklist misses unqualified references |
| APA-333 | MEDIUM | ✅ designed | [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | Personal PII is not masked — masking covers credentials only, and export pulls up to 10K rows |
| APA-334 | LOW | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | DatabaseExplorerPage.tsx | Sorting on masked columns leaks relative ordering of the hidden values |
| APA-335 | HIGH | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | (cross-cutting) | db-migrate authority boundary was implemented server-side but never propagated to the admin-panel FE |
| APA-336 | HIGH | ✅ designed | [database-mgmt](findings/database-mgmt.md) | (cross-cutting) | Global ResponseInterceptor has no StreamableFile/binary bypass — every file-download endpoint in adm |
| APA-337 | HIGH | ✅ designed | [database-mgmt](findings/database-mgmt.md) | (cross-cutting) | Admin-panel 'Backups' feature is a paper capability in production — runtime dependencies absent from |
| APA-338 | MEDIUM | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | (cross-cutting) | Hand-written FE types drift systemically from backend responses (no codegen) — three of the drifts s |
| APA-339 | LOW | ⏳ pending | [database-mgmt](findings/database-mgmt.md) | (cross-cutting) | Security posture of the section is otherwise solid (verified, not assumed) |
| APA-340 | HIGH | ✅ designed | [settings-email-audit](findings/settings-email-audit.md) | SystemSettingsPage.tsx | Email, Security, Rate-Limit and Maintenance settings persist but nothing enforces or consumes them ( |
| APA-341 | HIGH | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | SystemSettingsPage.tsx | 'Send Test' tests the env-var SMTP config, not the settings the admin typed or saved |
| APA-342 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | SystemSettingsPage.tsx | System Info tab contract drift — server/database sections never render, returned data not displayed |
| APA-343 | LOW | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | SystemSettingsPage.tsx | Retired settings endpoints still exposed and return 410 at runtime |
| APA-344 | CRITICAL | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | EmailTemplatesPage.tsx | Email templates are never consumed by any real send path — edits have zero effect on emails actually |
| APA-345 | HIGH | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | EmailTemplatesPage.tsx | 'New Template' creation is impossible — modal state never initializes, typing is a no-op, Save silen |
| APA-346 | HIGH | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | EmailTemplatesPage.tsx | Backend template test-send endpoint is a stub — returns 'Test email would be sent (email service int |
| APA-347 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | EmailTemplatesPage.tsx | DB unique constraint on code makes the tenant-override feature impossible |
| APA-348 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | EmailTemplatesPage.tsx | Template CRUD bodies bypass the global ValidationPipe — DTOs are TS interfaces, no server-side valid |
| APA-349 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | EmailTemplatesPage.tsx | Enable/Disable toggle failures are swallowed — console.error only, optimistic UI already reconciled |
| APA-350 | LOW | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | EmailTemplatesPage.tsx | Preview API response shape drift (latent) |
| APA-351 | CRITICAL | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | IpAccessRulesPage.tsx | IP access rules are persisted but enforced by nothing — blacklisting an IP blocks nothing (false sec |
| APA-352 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | IpAccessRulesPage.tsx | Backend route shadowing: GET /settings/ip-access/stats is captured by @Get(':id') |
| APA-353 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | IpAccessRulesPage.tsx | Rule list and stats capped at first 100 rules with no pagination UI |
| APA-354 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | IpAccessRulesPage.tsx | Bulk Add loops single-create and aborts on first failure, leaving partial inserts; backend bulk endp |
| APA-355 | LOW | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | IpAccessRulesPage.tsx | CRUD DTOs are TS interfaces — global ValidationPipe skipped; FE 'isActive' on create silently ignore |
| APA-356 | HIGH | ✅ designed | [settings-email-audit](findings/settings-email-audit.md) | AuditLogPage.tsx | Every filter on the audit page returns 400 — @Query() DTO + forbidNonWhitelisted rejects the filter  |
| APA-357 | HIGH | ✅ designed | [settings-email-audit](findings/settings-email-audit.md) | AuditLogPage.tsx | Export always fails (limit=10000 > @Max(100)); even if accepted it would silently truncate to 100 ro |
| APA-358 | MEDIUM | ✅ designed | [settings-email-audit](findings/settings-email-audit.md) | AuditLogPage.tsx | Severity vocabulary drift: FE uses low/medium/high/critical, backend enum is info/warning/critical |
| APA-359 | HIGH | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | AuditLogPage.tsx | Detail modal 'Metadata' section can never display — FE reads log.metadata, backend field is 'details |
| APA-360 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | AuditLogPage.tsx | Search is doubly broken: uuid ILIKE would raise a DB error that the service converts into a silent e |
| APA-361 | LOW | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | AuditLogPage.tsx | Table column sort flags are cosmetic and CSV export omits tenant/metadata columns |
| APA-362 | HIGH | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | (cross-cutting) | Service-wide footgun: mixing named @Query params with an un-named @Query() PaginationQueryDto 400s e |
| APA-363 | HIGH | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | (cross-cutting) | Admin 'configuration' is split across three disconnected stores; the admin panel writes the one noth |
| APA-364 | MEDIUM | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | (cross-cutting) | Settings-module CRUD DTOs are TypeScript interfaces, so the global ValidationPipe validates nothing  |
| APA-365 | LOW | ⏳ pending | [settings-email-audit](findings/settings-email-audit.md) | (cross-cutting) | Auth/guard coverage verified — no unguarded endpoints in this section |
| APA-366 | HIGH | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | CSRF double-submit is false security: FE sends X-CSRF-Token but admin-api-service has zero server-si |
| APA-367 | HIGH | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | PlatformAdminGuard never consults the token blacklist — force-logout / revocation is silently ineffe |
| APA-368 | MEDIUM | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | All app-level rate limiting is in-memory per-process (not Redis) and globally disableable — public p |
| APA-369 | MEDIUM | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | Guard ordering makes failed-auth requests invisible to app-level throttling, and failed admin auth i |
| APA-370 | MEDIUM | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | Sensitive admin mutations missing tightened throttles; circuit-breaker reset has no app-level rate l |
| APA-371 | LOW | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | Public-route metadata key is string-coupled and triplicated; password-reset controller redefines its |
| APA-372 | LOW | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | Unauthenticated Prometheus /metrics endpoint exposed on the container network |
| APA-373 | LOW | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | CORS allowlist drift: dead X-Impersonate-User header allowed; X-CSRF-Token not allowed |
| APA-374 | LOW | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | AdminBypassRlsInterceptor wraps ALL requests — including unauthenticated @Public routes — in RLS byp |
| APA-375 | LOW | ⏳ pending | [xc-auth-guards](findings/xc-auth-guards.md) | (cross-cutting) | Coverage summary (provable): all 35 HTTP controllers sit behind global PlatformAdminGuard (RS256 JWT |
| APA-376 | HIGH | ✅ designed | [xc-db-parity](findings/xc-db-parity.md) | (cross-cutting) | Auth-schema RBAC + invitation DDL is owned by admin-api's migration chain (ownership inversion, depl |
| APA-377 | MEDIUM | ⏳ pending | [xc-db-parity](findings/xc-db-parity.md) | (cross-cutting) | Dead table + dead entity: auth.tenant_invitations (TenantInvitation) — created and forFeature-regist |
| APA-378 | MEDIUM | ⏳ pending | [xc-db-parity](findings/xc-db-parity.md) | (cross-cutting) | Dead table + dead entity: admin.plan_module_assignments (PlanModuleAssignment) — zero consumers repo |
| APA-379 | MEDIUM | ⏳ pending | [xc-db-parity](findings/xc-db-parity.md) | (cross-cutting) | auth.tenants is mapped by TWO hand-written entity classes in the same DataSource — a duplication tha |
| APA-380 | LOW | ⏳ pending | [xc-db-parity](findings/xc-db-parity.md) | (cross-cutting) | Migration location and runner deviate from the platform ADR-011 pattern, and the two in-repo comment |
| APA-381 | LOW | ⏳ pending | [xc-db-parity](findings/xc-db-parity.md) | (cross-cutting) | CLI data-source entity glob excludes the LegalHold entity although admin-api owns the compliance.leg |
| APA-382 | LOW | ⏳ pending | [xc-db-parity](findings/xc-db-parity.md) | (cross-cutting) | admin.audit_logs: performedByEmail filter has no supporting index (all other list filters are indexe |
| APA-383 | LOW | ⏳ pending | [xc-db-parity](findings/xc-db-parity.md) | (cross-cutting) | Verified-clean baseline for everything else: full entity<->migration<->registry parity across all 60 |