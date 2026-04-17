# Multi-Tenant SaaS Audit — 2026-04-W16

**Cycle:** 2026-04-W16 · **Scope anchor:** `main` HEAD (2026-04-16) · **Mode:** READ-ONLY.

Slice covers schema-per-tenant adoption across the 7 services listed in CLAUDE.md (farm, sensor, hr, messaging, hydroponics, alert-engine, ai), tenant-ID sourcing (JWT vs `x-tenant-id` header), tenant lifecycle (provisioning saga, archival, erasure), plan gating, per-tenant quotas, cross-tenant access / impersonation, GDPR Art. 20 portability, and per-tenant observability / cost attribution.

Finding IDs follow `MT-{SEVERITY}-{NNN}` per CLAUDE.md §Review Finding Traceability. Prior MT reviews reread: `docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md` and `docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md`. Findings from those reports that remain unfixed are escalated by one severity level per the agent's prior-work rule; two items in this report (MT-CRITICAL-002 quota fail-open, MT-HIGH-002 plan-limit enforcement) are prior-work escalations.

## Table 1 — Pattern usage

| Pattern | Expected | Actual | Example file | Signal |
|---|---|---|---|---|
| `createTenantConnectionBootstrap('<svc>')` wired in `app.module.ts` | 7 services | **7/7** (farm, sensor, hr, messaging, hydroponics, alert, ai) | `apps/farm-service/src/app.module.ts:37` | HEALTHY — L1 search-path layer wired cleanly across the tenant-schema set. |
| `SchemaDriftModule.forRoot` registered | 13 (per W0 BLOCKER-8 consensus) | **13/13** (admin-api, auth, ai, alert, billing, config, farm, hr, hydroponics, messaging, notification, sensor + namespaced as `billing`, `notification`, etc.) | `apps/farm-service/src/app.module.ts:379` | HEALTHY — ADR-012 bootstrap validator universally wired. |
| `tests/invariants/_constants.ts` single-source-of-truth file | Present (per W0 BLOCKER-8 claim) | **ABSENT** | — | SURPRISE — see MT-HIGH-001. The W0 claim that `SCHEMA_OWNING_SERVICES=13 / PER_TENANT_SCHEMA_SERVICES=7` is encoded in a shared constants module is not yet reflected in code. No `_constants.ts` under `tests/invariants/` or anywhere in the tree. The invariant spec (`e2e/tests/integration/schema-invariants.spec.ts`) still hardcodes `SHARED_SCHEMA_TABLES`, `ALLOWED_PUBLIC_TABLES`, etc. inline. |
| `TenantScopedRepository<T>` / `@InjectTenantRepository` usage in app code | Every tenant-data access | **0 usages across `apps/**`** (defined in `libs/backend-common/src/database/tenant-scoped-repository.ts` + 2 test files) | n/a | CRITICAL — see MT-CRITICAL-001. The repository wrapper designed to make cross-tenant queries structurally impossible is entirely unused. Isolation is carried 100 % by the search-path + RLS layers, leaving ~230 `@Entity` classes unshielded by the app-level guard. |
| `TenantRedisService.forTenant(redis, tenantId)` for key scoping | Every tenant Redis access | **0 usages across `apps/**`** (defined in `libs/backend-common/src/redis/tenant-redis.service.ts`, 141 raw Redis calls across the 7 + messaging services) | `apps/alert-engine/src/escalation/escalation-manager.service.ts:21` | CRITICAL — see MT-CRITICAL-002. L3 Redis isolation is entirely unenforced; key namespacing is ad-hoc per call-site. |
| `getScopedRepository()` (CLAUDE.md rule) | Every tenant-data query | **1 match in `apps/**`** (a migration) — zero production call sites | — | The CLAUDE.md rule "`getRepository()` is FORBIDDEN → use `getScopedRepository()`" is not being followed. Codebase has ~149 `.getRepository()` calls. Mitigating factor: most are inside `manager.getRepository()` (transactional) or billing/auth where RLS covers the shared-schema tables. Still a code-quality HIGH. |
| `createTenantSchemaMiddleware` / `TenantContextMiddleware` wiring | 7 services | **7/7** — middleware imported in every tenant-schema service module | `apps/farm-service/src/app.module.ts:35` | HEALTHY. |
| `EnableRowLevelSecurity` migration | ≥ 7 services | **2/7** (farm-service `1776000000000`, messaging-service `1782400000000`) | `apps/farm-service/src/database/migrations/1776000000000-EnableRowLevelSecurity.ts` | HIGH gap — 5 of 7 schema-per-tenant services ship no RLS migration (sensor, hr, hydroponics, alert-engine, ai). Isolation relies on search-path alone — L2 defense-in-depth layer missing. See MT-HIGH-003. |
| `WatchdogCronService` (CrossTenantProbe / SourceSchemaScanner / SchemaDriftDetector) | Ideally 7 services | **1/7** (farm-service only) | `apps/farm-service/src/infrastructure/watchdog-cron.service.ts:14` | HIGH gap. Watchdog is the only active canary for cross-tenant leaks; restricting it to farm-service means a breach in any other schema stays invisible until the next manual review. See MT-HIGH-004. |
| Tenant provisioning saga (PIVOT at Stripe / compensation chain) | 1 orchestrator, owner = admin-api | **Present** — `provisioning-saga.service.ts` with COMPENSABLE steps and atomic `PENDING → PROVISIONING` TOCTOU-safe UPDATE at `tenant-provisioning.service.ts:168-171` | `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:162-185` | HEALTHY — prior HIGH-001 (2026-04-10) is now partially fixed: status stays out of ACTIVE until the saga completes. Still missing PIVOT classification tags on each step and persisted idempotency key (see MT-HIGH-005). |
| Cascade erasure fan-out (`eraseTenantData` / `TenantErased` / `TenantPurged` events) | All 7 schema-per-tenant services + billing + notification | **0 matches anywhere in the repo** (except the agent's own .md references) | — | CRITICAL — see MT-CRITICAL-003. GDPR Art. 17 cascade is not implemented. `TenantArchivedEvent` exists in `libs/event-contracts/src/tenant-events.ts`, but no service has a corresponding erasure handler, no proof-of-erasure audit event, and no legal-hold precedence check outside messaging. |
| Impersonation surface (`X-Act-As-Tenant` + MFA step-up + dual-identity audit) | Admin-api-only, MFA required | **Present** — `TenantGuard` enforces `X-Act-As-Tenant` UUID validation + `mfaRequiredForCrossTenant` flag (default `true`), plus `ImpersonationSession` entity with session-rate-limit. `AuditLogService.logAsync()` used on cross-tenant hits. | `libs/backend-common/src/guards/tenant.guard.ts:46-77` · `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:72-106` | MEDIUM drift — `ImpersonationService` rate-limit falls back to in-memory `Map` when Redis is absent, logging the warning "multi-instance deployments bypass rate limits". Fail-closed policy for a cross-tenant surface is enterprise-grade; fail-open-with-warning is a prior-work echo of the AI quota issue. See MT-MEDIUM-001. |
| `PlanTier` enum (single source of truth) | 1 canonical definition | **4 definitions, all drifted from each other** — `libs/event-contracts/src/base-event.ts:121` (`'starter' \| 'professional' \| 'enterprise'`), `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:20` (FREE, TRIAL, STARTER, PROFESSIONAL, ENTERPRISE), `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:15` (TRIAL, STARTER, PROFESSIONAL, ENTERPRISE — no FREE), `apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts:11` | — | HIGH — see MT-HIGH-006. A feature gated on `PlanTier==='enterprise'` in one service will mis-gate a `TRIAL` or `FREE` tenant at the gateway because the event-contract cannot express those tiers. |
| `TenantPlan` integer-level hierarchy (`>=`) comparisons | Ordinal comparisons for gating | **None found** — all plan gating uses string equality on drifted enums | — | HIGH — see MT-HIGH-007. CLAUDE.md/agent spec requires `tenant.planLevel >= feature.requiredPlanLevel`. Current code is strict-equality-only; upgrades break gating. |
| Per-tenant rate-limit primitive (atomic Redis Lua INCR) | Gateway + billable/auth endpoints | **Atomic Redis INCR present in `gateway-api/guards/redis-rate-limit.store.ts` and `impersonation.service.ts`; ai-service `rate-limit.service.ts` falls back to in-memory** | `apps/gateway-api/src/guards/redis-rate-limit.store.ts` | PARTIAL — AI-service quota counter, token-budget, and impersonation rate-limit all have in-memory fallbacks that fail *open* on Redis outage. See MT-CRITICAL-002 (prior-work escalated). |
| Per-tenant observability (bounded-cardinality labels, no `tenant_id` on hot-path) | Allowlisted slow-moving metrics only | **No Prometheus metric emits `tenant_id` anywhere** (grep `labelNames.*tenant_id` / `Histogram.*tenant_id` / `Counter.*tenant_id` all zero hits) | — | HEALTHY on the cardinality axis, but see MT-MEDIUM-002: the inverse problem is now that per-tenant cost attribution has no instrumentation at all — no top-N pre-aggregated metric, no `tenant_info` / `tenant_storage_used_bytes` / per-tenant SLO recording rules. |

## Table 2 — Anti-pattern spots

| Anti-pattern | Count | Example file:line | Severity | Fix direction |
|---|---|---|---|---|
| `@Entity('...')` without `schema:` option on tenant-context entities | ≥ 5 direct hits | `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:52` (`@Entity('tenants')`), `:` tenant-module.entity.ts, `apps/ai-service/src/tenant-config/agent-config.entity.ts:13` (`@Entity('tenant_agent_configs')`), `apps/sensor-service/src/edge-device/entities/tenant-provisioning-key.entity.ts:17`, `apps/admin-api-service/src/tenant/entities/tenant-activity.entity.ts:31,70,103`, `apps/admin-api-service/src/settings/entities/tenant-configuration.entity.ts:14` | CRITICAL | ADR-011 hard rule. Each entity must declare the owning schema. `auth.tenants` is the highest-trust table in the platform — drift here breaks `schema-invariants.spec.ts` and can land in `public` again. MT-CRITICAL-004. |
| `manager.getRepository()` / `dataSource.getRepository()` on tenant-scoped data without `getScopedRepository()` wrapper | 149 occurrences across 81 files in `apps/**` | `apps/farm-service/src/scheduler/feeding-scheduler.service.ts:1158-1483` (9 raw `queryRunner.manager.getRepository` on tenant tables), `apps/hr-service/src/hr/handlers/*` (26 handlers) | HIGH | CLAUDE.md §Code-Quality: "`getRepository()` is FORBIDDEN → use `getScopedRepository()`". Most callers rely on RLS (`app.current_tenant`) to backstop them, but 5 of 7 tenant-schema services have no RLS migration (see MT-HIGH-003), so for those services the tenant filter is carried only by the connection bootstrap's search-path. If search-path is ever reset inside a transaction, every raw query becomes cross-tenant-capable. MT-HIGH-008. |
| `this.dataSource.query()` / `this.dataSource.getRepository()` on tenant tables | 4 raw-SQL hits inside `farm-service` alone | `apps/farm-service/src/equipment/handlers/list-equipment.handler.ts:351`, `apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts:1034`, `apps/farm-service/src/feeding/services/feeding-cron.service.ts:125,137` | HIGH | Raw SQL bypasses both RLS policy-rewrite and TypeORM scoping. For cron / scheduled paths, `withTenantContext()` from `libs/backend-common/src/context/with-tenant-context.ts` must wrap each per-tenant iteration. `feeding-cron.service.ts` already imports `withTenantContext` — verify every cron iteration is wrapped. MT-HIGH-009. |
| Raw Redis (`RedisService.get/set/incr/del/expire`) on tenant data without `TenantRedisService.forTenant()` | 141 occurrences across 25 files in the 7 tenant-schema services + messaging | `apps/alert-engine/src/escalation/escalation-manager.service.ts:21` (22 calls), `apps/ai-service/src/cost/rate-limit.service.ts` (2), `apps/messaging-service/src/message/services/storage-quota.service.ts` (4) | CRITICAL | Tenant keys are namespaced ad-hoc at each call-site. One miss = cross-tenant read/write in the cache layer. `TenantRedisService.forTenant(redis, tenantId)` exists and UUID-validates the tenant ID before prefixing; migrating the 25 call-sites removes an entire class of bugs. MT-CRITICAL-002. |
| Plan limits advertised but NOT enforced (farm, pond, sensor, alert, storage, API) | `PLAN_LIMITS` in gateway middleware | `apps/gateway-api/src/middleware/tenant-context.middleware.ts:187-233` defines the table; no enforcement guard or interceptor consumes it | HIGH | Prior MEDIUM-003 from 2026-04-10. Promoted to HIGH per unfixed-escalation rule. Static limit dict in the gateway is dead code unless every resource-creation path reads and honors it. MT-HIGH-002. |
| Quota counter fallback fails *open* on Redis outage | 3 call-sites | `apps/ai-service/src/cost/rate-limit.service.ts:28-37,82-90,131-171` (in-memory Map fallback), `apps/ai-service/src/cost/token-budget.service.ts:25-35,96-160`, `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:83-106,163-179` | CRITICAL | Fail-open for quota = runaway cost + brute-force window. Prior HIGH-002 escalated to CRITICAL per unfixed rule. Fail-closed in production; ship startup health-check that hard-fails the process if Redis is unreachable. MT-CRITICAL-002. |
| `TenantPlan` enum triplicated + drifted | 3 competing enums + 1 type alias | `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:20`, `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:15`, `apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts:11`, `libs/event-contracts/src/base-event.ts:121` | HIGH | Domain value objects must live in one place. Candidate SSOT: `libs/event-contracts/src/base-event.ts`, with `CUSTOM` / `TRIAL` / `FREE` added. Emit lint rule that forbids redefinition. MT-HIGH-006. |
| `x-tenant-id` header accepted on non-allowlisted endpoints | 30 files grep, gateway middleware + tenant-context middleware both handle it | `apps/gateway-api/src/middleware/tenant-context.middleware.ts` (Gateway copy — subdomain + path + header), `apps/event-store-service/src/guards/internal-api-key.guard.ts` (dev-mode bypass) | MEDIUM | Prior TENANT-REC-002 (2026-04-09) not yet acted on. Strip `x-tenant-id` at `StripInternalHeadersMiddleware` boundary; only accept on the 3 documented paths (pre-auth, cross-tenant-admin, edge-ingest). MT-MEDIUM-003. |
| Erasure-event contract absent (`TenantErased` / `TenantPurged`) | 0 hits | — | CRITICAL | GDPR Art. 17 non-compliance risk. Define events in `libs/event-contracts/src/tenant-events.ts`, add cascade handler stubs in all 7 tenant-schema services + billing + notification, enforce handler presence via a CI invariant. MT-CRITICAL-003. |

## Table 3 — Modernization opportunities (prioritized)

| # | Opportunity | Impact | Effort |
|---|---|---|---|
| 1 | Land `tests/invariants/_constants.ts` as SSoT for `SCHEMA_OWNING_SERVICES` (13) and `PER_TENANT_SCHEMA_SERVICES` (7). Import from `schema-invariants.spec.ts`, the provisioning saga (for fan-out target list), and a new CI check that asserts `createTenantConnectionBootstrap` is wired in every service in the list. Closes BLOCKER-8 claim drift. | HIGH | S |
| 2 | Require `TenantRedisService.forTenant()` for all Redis access in the 7 tenant-schema services. Ship ESLint rule `no-raw-redis-on-tenant-data` (AST pattern: `this.redisService.<op>(` where first arg contains `tenantId`). Migrate the 141 call-sites; the wrapper is already built. | CRITICAL | M |
| 3 | Emit per-tenant cost attribution metrics (compute / db / storage / egress / AI) as bounded-cardinality `top_n_*{rank,tenant_id}` counters with rank ≤ 20, per the agent spec §Per-Tenant Observability. No metric currently emits `tenant_id`, so cost attribution has no telemetry at all. | HIGH | M |
| 4 | Add `CrossTenantProbe` canary skill to provision-tenant lifecycle: on every tenant create, write a sentinel row scoped to the NEW tenant, then attempt to read it from a DIFFERENT tenant context. Fail-closed on any successful read. Extend watchdog coverage from farm-only to all 7 schema-per-tenant services. | CRITICAL | M |
| 5 | Enforce JWT-claim-only tenant sourcing via a middleware pipe: `requireJwtTenantId()` decorator the 7 tenant-schema services apply globally, with a narrow `@AllowHeaderTenantId({ reason })` escape hatch for the 3 allowlisted paths (pre-auth, cross-tenant admin, edge ingest). Closes TENANT-REC-002 (2026-04-09). | HIGH | S |
| 6 | Unify `TenantPlan` in `libs/event-contracts/src/base-event.ts` as a single string-literal union with ordinal metadata (`PLAN_LEVEL: Record<PlanTier, number>`). Remove the 3 duplicate entity-side enums. | HIGH | M |
| 7 | Define `TenantErased` / `TenantPurged` / `TenantExportRequested` events in event-contracts; add `eraseTenantData(tenantId, { dryRun })` handler stub to each tenant-schema service + billing + notification + messaging (10 targets). Wire legal-hold precedence check. CI invariant asserts every service in `PER_TENANT_SCHEMA_SERVICES` has a handler registered. | CRITICAL | L |
| 8 | Fail-closed Redis policy in production: `REDIS_AVAILABILITY=required` hard-fails `ai-service`, `gateway-api`, and `admin-api-service` bootstrap when Redis can't be contacted. No in-memory fallback at all in prod. | CRITICAL | S |
| 9 | Extend the CI invariant in `e2e/tests/integration/schema-invariants.spec.ts` to assert (a) `SchemaDriftModule.forRoot` is wired in every service whose name appears in `SCHEMA_OWNING_SERVICES`, and (b) `createTenantConnectionBootstrap` is wired in every service in `PER_TENANT_SCHEMA_SERVICES`. | HIGH | S |

## Findings

### MT-CRITICAL-001 — `TenantScopedRepository` / `@InjectTenantRepository` is unused across the entire application tree
- **Evidence:** `libs/backend-common/src/database/tenant-scoped-repository.ts` defines the class and the `@InjectTenantRepository` decorator; zero matches under `apps/**`. All 230+ `@Entity` classes in the tenant-schema services are accessed via raw `Repository<T>` (`InjectRepository`) or `manager.getRepository()`.
- **Impact:** The architectural layer designed to make cross-tenant queries structurally impossible is dead code. Isolation is entirely carried by the L1 (search-path) and L2 (RLS where present) layers. L2 is present in only 2 of 7 services (see MT-HIGH-003), leaving L1 as the sole control for 5 services. If a single transaction resets search-path (the 2026-04-07 farm-service incident class), every query becomes cross-tenant-capable in those services.
- **Root-cause fix:** Migrate call-sites per MT-MOD-2; add an ESLint rule forbidding `@InjectRepository(T)` on entities that carry a `tenantId` column; require `@InjectTenantRepository(T): TenantScopedRepository<T>`. Wire CI invariant.

### MT-CRITICAL-002 — Quota/rate-limit counters fail *open* on Redis outage (prior HIGH-002 escalated)
- **Evidence:** `apps/ai-service/src/cost/rate-limit.service.ts:28-37,82-90,131-171` (in-memory Map), `apps/ai-service/src/cost/token-budget.service.ts:25-35,96-160` (lost on restart), `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:83-106` (Map fallback). First flagged in the 2026-04-10 full-repo audit as HIGH-002; 6 days later still unfixed, so escalated to CRITICAL per the agent's prior-work rule.
- **Impact:** Fail-open on quota = runaway LLM cost the instant Redis blips; fail-open on impersonation rate-limit = brute-force window on the highest-trust cross-tenant surface.
- **Root-cause fix:** Remove the in-memory fallback branches entirely; hard-fail bootstrap if `REDIS_URL` can't be reached in production. Quota state must be shared, not best-effort.

### MT-CRITICAL-003 — Tenant erasure cascade (GDPR Art. 17) is not implemented
- **Evidence:** 0 grep hits for `eraseTenantData`, `TenantErased`, `TenantPurged` anywhere in the repo. `TenantArchivedEvent` exists but has no downstream consumer that removes tenant data. No proof-of-erasure audit. No cascade fan-out across the 7 tenant-schema services + billing + notification + messaging.
- **Impact:** Art. 17 non-compliance and Art. 20 unlinkable (can't prove erasure). A tenant archive does not delete data anywhere downstream.
- **Root-cause fix:** Ship per MT-MOD-7: event contract, 10 handler stubs, legal-hold precedence, signed proof-of-erasure audit, CI invariant. `legal_hold` column already exists on messaging entities — promote the pattern platform-wide.

### MT-CRITICAL-004 — Tenant-context entities missing `schema:` option (ADR-011 violation)
- **Evidence:** `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:52` (`@Entity('tenants')` — no schema), `apps/auth-service/src/modules/tenant/entities/tenant-module.entity.ts:28` (`@Entity('tenant_modules')`), `apps/ai-service/src/tenant-config/agent-config.entity.ts:13`, `apps/sensor-service/src/edge-device/entities/tenant-provisioning-key.entity.ts:17`, `apps/admin-api-service/src/tenant/entities/tenant-activity.entity.ts:31,70,103`, `apps/admin-api-service/src/settings/entities/tenant-configuration.entity.ts:14`.
- **Impact:** ADR-011 "Every `@Entity()` MUST declare `schema:`" violated by the single most trust-critical table (`auth.tenants`) and by several tenant-context tables. If TypeORM synchronize is ever flipped on, these land in `public`. The CI invariant `schema-invariants.spec.ts` catches tables-in-public but does not catch entities-without-schema-option at decoration time.
- **Root-cause fix:** Add `schema: 'auth'` (or correct schema) to each missing declaration. Ship the ESLint rule `@typescript-eslint/require-entity-schema` with a custom rule that flags `@Entity(…)` without `{ schema: … }`.

### MT-HIGH-001 — `tests/invariants/_constants.ts` SSoT file is absent (W0 BLOCKER-8 claim drift)
- **Evidence:** Audit scope says the file "just landed in W0" and instructs this report to sanity-check it. No such file exists — `tests/invariants/` directory is absent, and no `_constants.ts` matches `SCHEMA_OWNING_SERVICES` / `PER_TENANT_SCHEMA_SERVICES` globally.
- **Impact:** The claimed SSoT that disambiguates the 13-vs-7 distinction is still implicit. `schema-invariants.spec.ts` hardcodes `SHARED_SCHEMA_TABLES` / `ALLOWED_PUBLIC_TABLES` / `MOVED_TABLES` / `MESSAGING_TABLES` inline with no shared import. If the provisioning saga adds an 8th schema-per-tenant service tomorrow, nothing fails.
- **Root-cause fix:** Land the constants file; rewrite the invariant spec to import from it; add CI invariant enforcing `createTenantConnectionBootstrap` wiring matches the list.

### MT-HIGH-002 — Plan limits advertised, not enforced (prior MEDIUM-003 escalated)
- **Evidence:** `apps/gateway-api/src/middleware/tenant-context.middleware.ts:187-233` defines `PLAN_LIMITS`. Only `maxUsers` is enforced (`apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:252-260`). `maxFarms`, `maxPonds`, `maxSensors`, `maxStorageGb`, `maxApiRequests` are unused. 2026-04-10 MEDIUM-003 escalated to HIGH (unfixed).
- **Impact:** Billing SaaS invariant broken — tenants can exceed plan limits. Enterprise tier `-1` ("unlimited") is hardcoded, not policy-driven.
- **Root-cause fix:** `PlanLimitEnforcementService` shared across admin, auth, farm, sensor, AI; every resource-creation command reads the limit and rejects with `429 PLAN_LIMIT_EXCEEDED`.

### MT-HIGH-003 — RLS only migrated in 2 of 7 tenant-schema services
- **Evidence:** `EnableRowLevelSecurity` migration exists in `apps/farm-service/src/database/migrations/1776000000000-EnableRowLevelSecurity.ts` and `apps/messaging-service/src/migrations/1782400000000-EnableRowLevelSecurity.ts`. No equivalent in sensor, hr, hydroponics, alert-engine, ai.
- **Impact:** L2 defense-in-depth (`app.current_tenant` session setting + `FOR ALL USING` policy) is missing in 5 services. Isolation hinges on the search-path layer alone. RLS is the second-to-last line before disaster in the 5-layer defense model.
- **Root-cause fix:** Port the farm-service RLS pattern (`TenantRlsService.generateCreatePolicySql`) to each remaining service; migrate with the blue-green-safe nullable → backfill → FORCE RLS sequence.

### MT-HIGH-004 — Watchdog only wired in farm-service
- **Evidence:** `apps/farm-service/src/infrastructure/watchdog-cron.service.ts:14` runs CrossTenantProbe + SourceSchemaScanner + SchemaDriftDetector every 10 min. No equivalent in the other 6 tenant-schema services.
- **Impact:** Cross-tenant leaks in sensor/hr/hydroponics/alert-engine/ai/messaging remain invisible until next manual review. The watchdog is the only active canary.
- **Root-cause fix:** Extract the `WatchdogCronService` pattern into `@aquaculture/backend-common`; wire in each service's app.module. Promote to a skill.

### MT-HIGH-005 — Provisioning saga steps lack `COMPENSABLE | PIVOT | RETRYABLE` classification + idempotency key
- **Evidence:** `apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts` implements `addStep(name, forward, compensate)` but no classification or persisted idempotency record. `saga` is instantiated per request (line 188) — no `(tenant_id, step_name, status, output)` persistence.
- **Impact:** On service restart mid-saga, in-flight tenant is stranded in `PROVISIONING`. Compensation cannot resume. PIVOT boundary (Stripe subscription) is undefined, so pre-pivot failures cannot be distinguished from post-pivot.
- **Root-cause fix:** Introduce `SagaStepDef<T>` with `kind: 'COMPENSABLE' | 'PIVOT' | 'RETRYABLE'`; persist to `admin.saga_executions(tenant_id, saga_type, step_name, status, output_json)`; resume on reboot.

### MT-HIGH-006 — `TenantPlan` / `PlanTier` triplicated and drifted
- **Evidence:** See pattern table.
- **Impact:** Cross-service feature gating is unreliable; a tenant at `ENTERPRISE` according to `auth-service` may be unrecognised by `ai-service` if the event payload traverses `PlanTier`.
- **Root-cause fix:** One canonical definition in `libs/event-contracts`, ordinal metadata, remove duplicates, ESLint `no-plantier-redefinition`.

### MT-HIGH-007 — No ordinal (`>=`) plan gating; all gates use strict equality
- **Evidence:** grep of `planLevel >=` across the repo returns no hits.
- **Impact:** An ENTERPRISE tenant fails a feature check written as `plan === 'professional'`. CLAUDE.md/agent spec requires `>=` ordinal comparison.
- **Root-cause fix:** Ship `PLAN_LEVEL: Record<PlanTier, 1|2|3|4>` and `canAccess(feature, tenantPlan)` helper in event-contracts; migrate call-sites.

### MT-HIGH-008 — ~149 `.getRepository()` calls in `apps/**` bypass `getScopedRepository()` (CLAUDE.md violation)
- **Evidence:** See anti-pattern table. Breakdown: `feeding-scheduler.service.ts` 9 hits, billing handlers 28, auth-service 15, hr handlers 26.
- **Impact:** CLAUDE.md rule violated at scale. Safety net is RLS + search-path, but RLS is missing in 5 of 7 schema-per-tenant services.
- **Root-cause fix:** ESLint rule; migrate gradually once `getScopedRepository()` wraps save/update/delete (currently missing per the comment in `tenant-scoped-repository.ts:43-45`).

### MT-HIGH-009 — Raw `this.dataSource.query()` on tenant tables in farm-service scheduler + feeding paths
- **Evidence:** `apps/farm-service/src/equipment/handlers/list-equipment.handler.ts:351`, `apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts:1034`, `apps/farm-service/src/feeding/services/feeding-cron.service.ts:125,137`.
- **Impact:** Raw SQL bypasses TypeORM scoping. RLS catches it in farm-service specifically (RLS migration present), but the pattern is risky — if copied into a service without RLS, it's cross-tenant-capable.
- **Root-cause fix:** Parameterize via `QueryBuilder` with explicit tenantId where-clause, or wrap every raw-SQL call in `withTenantContext(tenantId, …)`.

### MT-MEDIUM-001 — Impersonation rate-limit falls back to in-memory Map when Redis is absent
- **Evidence:** `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:83-106,163-179`.
- **Impact:** Multi-instance impersonation fleet can bypass the 5/5min rate limit.
- **Root-cause fix:** Per MT-MOD-8, fail-closed Redis in production.

### MT-MEDIUM-002 — No per-tenant observability or cost-attribution telemetry
- **Evidence:** No Prometheus metric emits `tenant_id` anywhere. No bounded-cardinality `tenant_info` / `tenant_storage_used_bytes` counter.
- **Impact:** No cost attribution by tenant. FinOps invariant fails.
- **Root-cause fix:** Per MT-MOD-3, expose `top_n_*{rank,tenant_id}` counters in observability-service with rank ≤ 20; add recording rules.

### MT-MEDIUM-003 — `x-tenant-id` header still broadly accepted (prior TENANT-REC-002 unfixed)
- **Evidence:** `apps/gateway-api/src/middleware/tenant-context.middleware.ts` Priority 2; `libs/backend-common/src/middleware/tenant-context.middleware.ts` lines 97-109.
- **Impact:** Defence-in-depth weakness. Low exploitability (JWT takes priority), but header should be stripped at the ingress for authenticated endpoints to reduce attack surface.
- **Root-cause fix:** Per MT-MOD-5.

## Exit summary

This slice audit completes pattern-usage, anti-pattern, and modernization tables per `docs/reviews/_audit/README.md`. Findings are cross-referenced against the two prior MT reviews; unfixed items escalated per the agent's prior-work rule.

**Systemic patterns across the slice:**
1. **Isolation layers defined but not enforced at app code** — `TenantScopedRepository` and `TenantRedisService` are infrastructure primitives that zero app call-sites actually use. Isolation leans entirely on search-path + partial RLS.
2. **In-memory fallbacks on distributed state** — AI quota, impersonation rate-limit, token budget. Fail-open policy across the board on what should be fail-closed surfaces.
3. **Contract SSoT drift** — `TenantPlan` triplicated; `PlanTier` deficient; `_constants.ts` claimed-but-absent.

Feeds into: `docs/plans/W2-knowledge-ssot/` (next phase) with priority on MT-CRITICAL-001, MT-CRITICAL-002, MT-CRITICAL-003, and MT-CRITICAL-004.

## References

- `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts:64-80` — search-path bootstrap factory (L1)
- `libs/backend-common/src/database/tenant-scoped-repository.ts:70-150` — `TenantScopedRepository<T>` (unused)
- `libs/backend-common/src/redis/tenant-redis.service.ts` — `TenantRedisService.forTenant()` (unused)
- `libs/backend-common/src/guards/tenant.guard.ts:22-100` — L5 request-scoped tenant guard with `X-Act-As-Tenant` + MFA
- `libs/backend-common/src/database/watchdog/{cross-tenant-probe,source-schema-scanner,schema-drift-detector}.ts` — canary primitives
- `libs/backend-common/src/database/rls/tenant-rls.service.ts` — RLS policy generator (wired in farm + messaging only)
- `libs/event-contracts/src/base-event.ts:121` — `PlanTier` (deficient)
- `libs/event-contracts/src/tenant-events.ts:1-80` — `TenantCreated` / `TenantStatusChanged` / `TenantArchived` (no erasure event)
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:162-185` — saga orchestrator entry point
- `apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts` — saga implementation (no classification / no persistence)
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:72-200` — impersonation + rate-limit (Map fallback)
- `apps/farm-service/src/infrastructure/watchdog-cron.service.ts:14-78` — only watchdog in the repo
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts:187-233` — `PLAN_LIMITS` (unenforced)
- `apps/ai-service/src/cost/{rate-limit,token-budget}.service.ts` — quota (Map fallback)
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:52` — `@Entity('tenants')` without `schema:`
- `e2e/tests/integration/schema-invariants.spec.ts:46-100` — invariant spec with inline hardcoded constants
- Prior MT reviews: `docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md`, `docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md`
