# Unified Audit — 2026-04-W16

**Cycle:** 2026-04-W16 · **Owner agent:** context-manager · **Mode:** Meta-synthesis (READ-ONLY).
**Input slices:** 8 reports in `/var/aqua-saas/docs/reviews/_audit/`.
**Plan reference:** `/root/.claude/plans/declarative-riding-shamir.md` Part A.4 + AMENDMENT-B.

---

## Executive summary

Eight slice audits converge on a single systemic crisis: **the platform's architectural invariants are declared but not compile-time-enforced.** CLAUDE.md names "Make it impossible" as the top tier of the remediation hierarchy — yet the codebase holds the opposite posture. Tenant isolation, event contracts, schema ownership, HMAC signing, and secret-key derivation are all specified as structural properties but realised as convention + optional runtime validators.

Five cross-cutting systemic patterns emerge:

1. **Isolation primitives exist but are entirely unused in app code** — `TenantScopedRepository`, `TenantRedisService.forTenant`, `@SchemaEntity` (absent), `createTenantQueryKey()` (4 files only). The factories are there; the call-sites are not.
2. **"Fail-open on infrastructure outage" across quota/rate/dedup surfaces** — AI cost, impersonation rate-limit, Stripe webhook dedupe, plan-limit enforcement. Every distributed counter has an in-memory fallback that silently defeats the invariant.
3. **ADR-011 schema attribution is the single largest compliance gap** — 157 `@Entity()` declarations (definitive count) missing `schema:` spanning 11 services; runtime `SchemaDriftValidator` is advisory-only by default; `config-service` also targets `public` schema in its migration runner.
4. **Event contracts + transactional outbox + NATS backbone are half-adopted** — 180 inline event literals bypass `createBaseEvent()`; 90 direct `eventBus.publish` calls bypass the 3-service outbox; 8 of 9 event domains ship without JSON Schema validators.
5. **Secret-key / HMAC / CSP hardening is partial** — SCADA SQLCipher fallback to a shared constant key; gateway→subgraph HMAC omits method/path/body-hash; CSP still whitelists `cdn.jsdelivr.net` on both the React shell and the SCADA HMI; query-param tenant-ID fallback in middleware.

Every one of these has a tier-1 "make-impossible" fix that is 1–5 days of work, but the remediation hierarchy breaks down at enforcement: the platform has no tier-1 lint rule set, no AST-invariant test layer, no compile-time brand on event IDs reaching the publisher, and no automated commit-to-finding traceability. **Part B (agent knowledge SSoT), Part C (skills catalog), and Part D (gate infrastructure) must address this posture shift — not each individual finding.** The findings are symptoms of the control-plane gap.

---

## Finding reconciliation (three-way disagreements)

| Claim | Data slice | Platform slice | Anti-patterns slice | Definitive |
|---|---|---|---|---|
| `@Entity()` without `schema:` | **180** (DATA-HIGH-001) | **21** (PLAT-CRITICAL-001 — scope-limited) | **157** (explicit grep + reconciliation math) | **157** — anti-patterns ran the rigorous grep (268 total `@Entity`, 53 with schema, 157 violating, remainder are correct or library-internal). Data-expert count inflated by counting all 209 bare-form declarations including ~22 compliant overrides; platform-services count was scope-limited to billing/event-store/config/hydroponics/alert. |
| `getRepository()` direct calls | ~155 matches / 4 confirmed leaks (DATA) | — | **166 total / 142 in apps-non-test; ~20 confirmed non-transactional leaks** (ANTI) | **~20 confirmed leaks**, concentrated in `feeding-program.resolver.ts`, billing query-handlers, compliance services, and `outbox-worker.service.ts:126`. Remaining ~145 are transaction-bound `manager.getRepository` calls (acceptable). SEC-HIGH-007 enumerates exact sites. |
| Inline event literals | 0 in prod / 13 in test fixtures (DATA) | — | **180 in prod** (ANTI — 259 `eventType:` hits − 79 `createBaseEvent()` call sites = 180 inline) | **180** — the data-expert slice counted only canonical-shape literals (`{ eventId: crypto.randomUUID(), … }`); the anti-patterns slice counted all `eventType:` occurrences that don't route through `createBaseEvent()`. Both are measuring different things: the 180 includes many discriminated-type literals that technically pass at runtime but bypass the branded-EventId gate. For the Part D lint rule, 180 is the target. |
| `EnableRowLevelSecurity` migration coverage | — | — | **2/7** (farm, messaging) per multi-tenant slice | **2/7** — MT-HIGH-003 is authoritative. Sensor, hr, hydroponics, alert-engine, ai ship without RLS. |
| `console.*` in production backend | — | — | **2** in apps non-test (ANTI) | **0 real violations** — the 2 hits are in `__tests__/` directories mislabeled as non-test by glob. Backend discipline is clean. Frontend is 825 across 201 files, concentrated in `web/modules/admin-panel/*`. |
| Tech anchors (Vite/React/plugin versions) | — | — | — (frontend slice only) | **Vite ^5.0.0** (shell/remotes), **^5.4.0** (aquamobil); **React 18.3.1** shell, **^18.2.0** remotes; **eslint-plugin-react-hooks ^4.6.0** shared-ui vs **^5.0.0** modules; **Module Federation = `@originjs/vite-plugin-federation`** (not `@nx/module-federation`). See FE-HIGH-001 and the corrected anchor table below. |
| SchemaDriftModule coverage | 12/12 db-owning services (DATA) | 5/6 scope services (PLAT — event-store missing) | — | **Disagreement resolved: 12/12 overall, event-store-service is the exception.** Data-expert counted "db-owning" services loosely; platform-services called out the specific gap. Treat as: event-store-service is the odd one out; every other database-owning service wires it. |
| Tenant plan enum / PlanTier | — | — | — (MT slice only) | **4 drifted definitions**: `base-event.ts:121` (3 tiers), `admin-api/tenant.entity.ts:20` (5 tiers including FREE), `auth-service/tenant.entity.ts:15` (4 tiers no FREE), `admin-api/analytics/tenant.entity.ts:11`. Per MT-HIGH-006. |

---

## Cross-slice systemic patterns

### SYS-1 — Control-plane authenticity crisis: declared invariants are not compile-enforced

**Occurrences across slices:**
- DATA-HIGH-001: 157 `@Entity()` without `schema:`; ADR-011 declared, not compiled
- PLAT-CRITICAL-001: same
- ANTI (§4): same count with reconciliation math
- ADR-006-TIER1-FALSE-POSITIVE: `BaseEvent.eventId` is branded but `eventBus.publish()` does not enforce the brand at the publisher signature
- FE-CRITICAL-001: `createTenantQueryKey()` is a regular function, not a phantom/brand type; bypass is invisible
- MT-CRITICAL-001: `TenantScopedRepository` defined, never imported in `apps/**`
- ADR-011-TIER3-CRITICAL: `tools/eslint-rules/` directory does not exist; Layer-1 lint tier never started
- EDGE-CRITICAL-002: SCADA SQLCipher key `unwrap_or_else(|_| "default-machine-id")` — the opposite of a compile-time invariant

**Tier-1 invariant (Part B/C/D scaffold):**

1. **Knowledge layer (Part B)** — Publish an "invariant authoring contract" that classifies each rule by enforcement tier. Every ADR and every CLAUDE.md rule lands with a tier tag.
2. **Skills layer (Part C)** — Ship these as skills: `brand-event-id`, `schema-entity-decorator`, `tenant-query-key-brand`, `enforce-scoped-repository`, `derive-db-key-fail-closed`. Each skill produces a wrapper that makes the violation structurally impossible.
3. **Gate layer (Part D)** — A new `tools/eslint-rules/` workspace with `require-entity-schema`, `no-inline-event-literal`, `no-direct-event-publish`, `no-raw-redis-on-tenant-data`, `no-bare-tenant-query-key`, `require-finding-id-on-todo`. CI runs the new rules as `error` on `apps/**/src/**` and `web/**/src/**`; tests tolerated via the boundary-files allowlist.

### SYS-2 — Fail-open on distributed infra outages

**Occurrences:**
- MT-CRITICAL-002: AI quota + impersonation rate-limit + token budget Map fallback
- PLAT-HIGH-004: Stripe webhook dedupe uses Redis `setNx` (ephemeral) not durable `ProcessedWebhookEvent`
- MT-HIGH-002: `PLAN_LIMITS` defined, unused; fail-open by default
- EDGE-CRITICAL-002: `machine-id` read fails → fallback constant SQLCipher key (fail-open to shared-key)
- SEC-MEDIUM-008: OPA fallback policy allows resources without tenantId (fail-open)

**Tier-1 invariant:** Introduce a `RequiredInfra<T>` branded type. `RedisService`, `MachineIdService`, `OpaClient` inject as `RequiredInfra<RedisClient>` in production; bootstrap hard-fails if the provider cannot contact the dependency. Fallback policies are typed as `never` — the compiler refuses the in-memory escape. Anti-pattern skill: `no-in-memory-fallback-on-infra`.

### SYS-3 — Dead-code security defenses: implemented, wired, unused

**Occurrences:**
- SEC-HIGH-004: `OpaPolicyGuard` + `PolicyEnforcerService` full stack, zero `@OpaPolicy()` decorators in production
- MT-CRITICAL-001: `TenantScopedRepository` / `@InjectTenantRepository` defined, unused
- MT-HIGH-004: `WatchdogCronService` pattern only in farm-service
- MT-HIGH-003: `TenantRlsService` policy generator only called in 2 of 7 services
- FE-HIGH-002: GraphQL codegen pipeline exists, produces no artifact and zero consumers
- ADR-004, ADR-005: Temporal + OpenSearch ADRs marked "Accepted" with zero implementation (ADR-004-TIER4-CRITICAL, ADR-005-TIER4-CRITICAL)

**Tier-1 invariant:** Every "defense-in-depth" or "architectural choice" flagged in an ADR must be covered by (a) an invariant test proving the first call-site exists, or (b) a scheduled supersede ADR. The `adoption-invariants.spec.ts` file referenced in `tests/invariants/_constants.ts:7` does not yet exist — creating it is a Part D deliverable.

### SYS-4 — Partial/half migrations shipped as complete

**Occurrences:**
- EDGE-HIGH-002: Service-worker precache fixed (no CDN); CSP header still whitelists CDN — half-fix
- EDGE-CRITICAL-001: `failover_manager` command handler references a non-existent AppState field — "fix" landed but wiring missing; tree compile-broken
- FE-CRITICAL-001: `createTenantQueryKey()` factory shipped; adoption stalled at 4 files
- DATA-HIGH-004: Outbox pattern present in 3/12 services
- SEC-HIGH-002 + SEC-HIGH-003: HMAC tenant-binding landed; method/path/body-binding missing — replay surface still open
- ADR-012 Layer-1 ESLint rule: explicitly deferred to "+1 month from 2026-04-14" with no tracked owner

**Tier-1 invariant:** The `Closes:` commit footer + a `PLAN-COMPLETION-CHECKLIST.md` skill that emits a machine-readable manifest. CI gate (Part D) refuses to close a plan task unless every listed invariant test passes. This closes the "half-fix passes review" failure mode directly.

### SYS-5 — Observability never installed where the infrastructure exists

**Occurrences:**
- EDGE-HIGH-005: `tracing-opentelemetry 0.28` compiled in, zero `#[instrument]` on 943 public fns
- MT-MEDIUM-002: No Prometheus metric emits `tenant_id`; no per-tenant cost attribution telemetry
- PLAT-HIGH-005: Projection tail query has no safe-tail grace window (event-store correctness)
- DATA-MEDIUM-004: JSON Schema validators cover 1/9 event domains

**Tier-1 invariant:** Observability isn't a "make it impossible" category, but a `TelemetryContract` can be declared per public boundary API: the function signature accepts an opentelemetry Span or is wrapped by a `@Traced(...)` decorator; lint enforces presence on hot-path boundaries (edge: MQTT publish, Modbus read/write; backend: gateway resolver, outbox worker, event-bus consumer). Missing telemetry = lint error on hot-path files listed in a `hot-paths.json` manifest.

---

## False positives from slice agents

- **MT-HIGH-001 (`tests/invariants/_constants.ts` absent):** **FALSE.** Confirmed present at `/var/aqua-saas/tests/invariants/_constants.ts` (76 lines, SHA-valid, git-blamed to commit `ad7ec82d feat(agentic,w0): SCHEMA_OWNING_SERVICES=13 single source of truth`). The file declares `SCHEMA_OWNING_SERVICES` (13 entries) and `PER_TENANT_SCHEMA_SERVICES` (7 entries) exactly as the BLOCKER-8 consensus specified. The slice agent evidently ran during a branch-switch window or cached a stale Glob result. Downstream MT-HIGH-001 escalations based on "claim drift" MUST be rescinded before Part B. However: the file self-references `tests/invariants/adoption-invariants.spec.ts` which **does not yet exist** — that spec file remains a legitimate gap (tracked as new finding CTX-HIGH-001 below).
- **MT-HIGH-001 secondary claim (invariant spec still hardcodes constants inline):** **TRUE but independent of the file existence.** `e2e/tests/integration/schema-invariants.spec.ts` does still hardcode its own constants inline rather than importing from `_constants.ts`. This is a real finding — promote to CTX-MEDIUM-001.
- **ADR-drift-matrix "tests/invariants/_constants.ts:13-15 cited":** **TRUE**, validated against the file.
- **DATA-HIGH-001 count of 180 missing-schema entities:** **FALSE-HIGH (overcount).** Reconciled count is 157 (per anti-patterns slice rigorous grep). No correction needed on the finding itself — the root-cause fix is identical — but Part B documentation should cite 157, not 180.
- **PLAT-CRITICAL-001 count of 21:** **FALSE-LOW (undercount).** Scope-limited to 5 services. Definitive count is 157 across 11 services.
- **FE-CRITICAL-002 "post-load SRI = race-with-execution":** **TRUE** — verified the integrity guard patches `Document.prototype.createElement` in JS before any remote loads, but the browser doesn't validate integrity until script execution. Domain rule confirms.
- **EDGE-CRITICAL-001 "tree does not compile":** **TRUE** — confirmed via grep: `AppState` in `sens-api-gateway/src/main.rs:240-282` declares no `failover_manager` field; `commands.rs:3334,3398` reference `state.failover_manager.as_ref()`. Either the Rust CI target was skipped on the relevant commit, or the file has drifted since the last `cargo build`. Deploy from HEAD is blocked.

---

## Severity-ranked composite finding list

Ordered by severity tier, preserving source-slice finding IDs and file/line references.

### CRITICAL (deploy-blocking)

| ID | Source | Summary | Key file:line |
|---|---|---|---|
| `SEC-CRITICAL-001` | security | `TenantContextMiddleware` accepts tenant ID from `?tenantId=` query param | `libs/backend-common/src/middleware/tenant-context.middleware.ts:108-112` |
| `PLAT-CRITICAL-001` | platform | 21 `@Entity()` classes missing `schema:` across billing/event-store/config/hydroponics/alert (subset of the 157 platform-wide) | `apps/billing-service/src/billing/entities/*.ts` (9), `apps/event-store-service/src/event-store/entities/*.ts` (4), etc. |
| `PLAT-CRITICAL-002` | platform | `config-service` migration runner targets `public` schema | `apps/config-service/src/app.module.ts:24` |
| `FE-CRITICAL-001` | frontend | React Query keys bypass tenant prefix at massive scale; `createTenantQueryKey()` adopted in only 4 of 30+ modules | `web/modules/tenant-admin/src/pages/TenantDashboard.tsx:150,172,182`; 265 queryKey sites in farm-module alone |
| `FE-CRITICAL-002` | frontend | MF SRI integrity check runs in application JS not at browser load time; `cdn.jsdelivr.net` allowlisted | `web/shell/src/utils/remoteIntegrity.ts:144-201`; `web/shell/index.html:19` |
| `MT-CRITICAL-001` | multi-tenant | `TenantScopedRepository<T>` + `@InjectTenantRepository` is entirely unused across `apps/**` | `libs/backend-common/src/database/tenant-scoped-repository.ts` — 0 call-sites in apps |
| `MT-CRITICAL-002` | multi-tenant | Quota/rate-limit counters fail OPEN on Redis outage (prior HIGH-002 escalated) | `apps/ai-service/src/cost/rate-limit.service.ts:28-37,82-90,131-171`; `admin-api-service/src/impersonation/services/impersonation.service.ts:83-106` |
| `MT-CRITICAL-003` | multi-tenant | Tenant erasure cascade (GDPR Art. 17) is not implemented | No `eraseTenantData` / `TenantErased` / `TenantPurged` anywhere in repo |
| `MT-CRITICAL-004` | multi-tenant | Tenant-context entities missing `schema:` option — including `auth.tenants` (highest-trust) | `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:52`; `apps/ai-service/src/tenant-config/agent-config.entity.ts:13`; `apps/sensor-service/src/edge-device/entities/tenant-provisioning-key.entity.ts:17` |
| `EDGE-CRITICAL-001` | edge | Edge gateway tree does not compile — `state.failover_manager` references a non-existent `AppState` field | `sens-api-gateway/src/commands.rs:3334,3398` vs `sens-api-gateway/src/main.rs:240-282` |
| `EDGE-CRITICAL-002` | edge | SCADA SQLCipher key collapses to a shared constant `"default-machine-id"` when machine-id read fails | `sens-api-gateway/src/scada_db.rs:71,98-100` |
| `ANTI-4` | anti-patterns | **157 `@Entity()` declarations missing `schema:` across 11 services** (definitive, reconciled) | See anti-patterns §4 breakdown; largest single-rule violation in the audit |
| `ANTI-5` | anti-patterns | **180 inline event literals bypass `createBaseEvent()`** (ADR-006 brand gate) | `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (8), `apps/admin-api-service/src/security/services/security-monitoring.service.ts` (8) |
| `ANTI-11` | anti-patterns | **90 direct `eventBus.publish()` calls** bypass transactional outbox; only `outbox-worker.service.ts:329` is legitimate | `apps/auth-service/src/modules/tenant/services/tenant.service.ts` (10), `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (8), `admin-api-service/suspend-tenant.handler.ts` (7) |
| `ANTI-3 (raw subset)` | anti-patterns | ~20 raw `dataSource.getRepository()` non-transactional leaks | `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:1070,1719,1788`; `apps/billing-service/src/billing/query-handlers/*.ts` |
| `ADR-011-TIER3-CRITICAL` | adr-drift | Layer-1 ESLint `require-entity-schema` never landed; `tools/eslint-rules/` directory does not exist | `docs/adr/011-schema-ownership-model.md` + `docs/adr/012-schema-drift-prevention.md` |
| `ADR-004-TIER4-CRITICAL` | adr-drift | ADR-004 Temporal marked Accepted, zero implementation | `docs/adr/004-temporal-workflow-adoption.md` is 0-byte; no `@temporalio` deps |
| `ADR-005-TIER4-CRITICAL` | adr-drift | ADR-005 OpenSearch marked Accepted, zero implementation | `docs/adr/005-opensearch-logging.md` is 0-byte; no `opensearch`/`@elastic` deps |

### HIGH (architectural / security)

| ID | Source | Summary | Key file:line |
|---|---|---|---|
| `DATA-HIGH-001` | data | 157 `@Entity()` declarations lack explicit `schema:` option (canonical per ANTI-4) | platform-wide; see anti-patterns §4 |
| `DATA-HIGH-002` | data | 4 non-transactional `dataSource.getRepository(Entity).save(...)` leaks | `libs/backend-common/src/audit/audited-operation.interceptor.ts:250`; `apps/config-service/src/configuration/handlers/{upsert,update,delete}-configuration.handler.ts` |
| `DATA-HIGH-003` | data | Session-scoped `SET search_path` inside migration bodies (pool-contamination risk) | `apps/messaging-service/src/migrations/1782300000000-AddTenantIdToMessageChildren.ts:197`; `1782400000000-EnableRowLevelSecurity.ts:102` |
| `DATA-HIGH-004` | data | Transactional outbox at 3/12 services; 9 services publish directly | Farm/hr/messaging only; 9 others do `NatsEventBus.publish` |
| `PLAT-HIGH-001` | platform | `SchemaDriftModule` not registered in event-store-service | `apps/event-store-service/src/app.module.ts` |
| `PLAT-HIGH-002` | platform | No `@platform/outbox` adoption in 6 platform services (billing/notification/config/event-store/observability/hydroponics) | Direct `eventBus.publish` across all |
| `PLAT-HIGH-003` | platform | Billing-service lacks Decimal-arithmetic discipline end-to-end | 11 `Number()`/`.toNumber()` coercions in query handlers; `metered-billing.service.ts:1276` float-round |
| `PLAT-HIGH-004` | platform | Stripe webhook idempotency is Redis-ephemeral, not durable `ProcessedWebhookEvent` | `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:138` |
| `PLAT-HIGH-005` | platform | Projection tail query has no safe-tail grace window | `apps/event-store-service/src/projections/projections.service.ts:336` |
| `SEC-HIGH-002` | security | Gateway→subgraph HMAC canonical input omits method/path/body-hash | `libs/backend-common/src/utils/service-identity.util.ts:52-55, 103-105` |
| `SEC-HIGH-003` | security | `StripInternalHeadersMiddleware` HMAC verification signs only `x-service-identity` (no timestamp/method/path/body) | `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts:71-74` |
| `SEC-HIGH-004` | security | `OpaPolicyGuard` wired but unused in production — zero `@OpaPolicy()` decorators | `apps/gateway-api/src/guards/opa-policy.guard.ts`; `apps/gateway-api/src/opa/policy-enforcer.service.ts` |
| `SEC-HIGH-005` | security | Audit interceptors + error filters accept `x-tenant-id` header as fallback on authenticated paths | `libs/backend-common/src/audit/audit-log.interceptor.ts:218`; `http-exception.filter.ts:100,166,213,277`; others |
| `SEC-HIGH-006` | security | PII in structured logs via string-concatenation — bypasses `maskPiiDeep` | `apps/gateway-api/src/middleware/jwt.middleware.ts:74`; `tenant-context.middleware.ts:62,87` |
| `SEC-HIGH-007` | security | Direct `getRepository()` calls bypass tenant scope (IDOR) | `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:1070,1719,1788`; `platform/libs/outbox/src/outbox-worker.service.ts:126`; 4 `apps/messaging-service/src/compliance/services/*.service.ts` sites |
| `FE-HIGH-001` | frontend | Tech anchor drift (Vite 7.3.1 claimed / ^5.0.0 actual; React 18.2 claimed / 18.3.1+^18.2.0 mixed; react-hooks 5.0.0 claimed / ^4.6.0 in shared-ui) | `web/shell/package.json:34`; `web/shared-ui/package.json:54`; `web/apps/aquamobil/package.json:38` |
| `FE-HIGH-002` | frontend | GraphQL codegen pipeline defined, produces no artifact, zero consumers; 243 hand-written query literals | `codegen.ts:16`; `web/shared-ui/src/generated/` absent |
| `FE-HIGH-003` | frontend | Meta-tag CSP fallback still allows `cdn.jsdelivr.net` without SRI/nonce | `web/shell/index.html:19-20` |
| `FE-HIGH-004` | frontend | `shared-ui` out of lockstep on `eslint-plugin-react-hooks` (^4.6.0 vs ^5.0.0 elsewhere) | `web/shared-ui/package.json:54` |
| `FE-HIGH-005` | frontend | Broad `queryClient.invalidateQueries({ queryKey: ['dashboard'] })` tenant-agnostic refetch storm | `web/modules/tenant-admin/src/pages/TenantDashboard.tsx:222`; 8 more sites |
| `EDGE-HIGH-001` | edge | Two prior-audit findings shipped without `Closes:` commit linkage (process finding) | `docs/reviews/edge-expert/2026-04-10-full-repo-audit.md` CRITICAL-001/HIGH-002/HIGH-003 |
| `EDGE-HIGH-002` | edge | SCADA CSP whitelists `unpkg.com` + `cdn.jsdelivr.net` (regression of prior HIGH-002) | `sens-api-gateway/src/scada_server.rs:776-777` |
| `EDGE-HIGH-003` | edge | mTLS optional on production MQTT path — IEC 62443 FR 1 risk | `sens-api-gateway/src/mqtt.rs:730-741` |
| `EDGE-HIGH-004` | edge | Scripting engine + command handler return `anyhow::Result` from public APIs | `sens-api-gateway/src/scripting/engine.rs:430,478,564,1015,1116,1988+`; `commands.rs` (17) |
| `EDGE-HIGH-005` | edge | Zero `#[instrument]` / tracing-span coverage across 66 source files, 943 public fns | `tracing-opentelemetry 0.28` compiled in, unused |
| `EDGE-HIGH-006` | edge | Health HTTP server exposes `/metrics` and `/diagnostics` without authentication | `sens-api-gateway/src/health.rs:680-685` |
| `MT-HIGH-002` | multi-tenant | Plan limits advertised, not enforced (prior MEDIUM-003 escalated) | `apps/gateway-api/src/middleware/tenant-context.middleware.ts:187-233` |
| `MT-HIGH-003` | multi-tenant | RLS only in 2 of 7 tenant-schema services | Farm + messaging only; sensor/hr/hydroponics/alert-engine/ai absent |
| `MT-HIGH-004` | multi-tenant | Watchdog only in farm-service (1 of 7) | `apps/farm-service/src/infrastructure/watchdog-cron.service.ts:14` |
| `MT-HIGH-005` | multi-tenant | Provisioning saga lacks `COMPENSABLE\|PIVOT\|RETRYABLE` classification + idempotency key | `apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts` |
| `MT-HIGH-006` | multi-tenant | `TenantPlan` / `PlanTier` triplicated and drifted (4 definitions) | `libs/event-contracts/src/base-event.ts:121`; 3 entity-side enums |
| `MT-HIGH-007` | multi-tenant | No ordinal (`>=`) plan gating; all gates use strict equality | grep `planLevel >=` returns zero hits |
| `MT-HIGH-008` | multi-tenant | ~149 `.getRepository()` calls in `apps/**` bypass `getScopedRepository()` | Breakdown: `feeding-scheduler.service.ts` 9, billing handlers 28, auth-service 15 |
| `MT-HIGH-009` | multi-tenant | Raw `this.dataSource.query()` on tenant tables in farm-service | `apps/farm-service/src/equipment/handlers/list-equipment.handler.ts:351`; `feeding-cron.service.ts:125,137` |
| `ANTI-1 (non-test)` | anti-patterns | ~60 production `as any` in `web/modules/**` + `libs/backend-common` | `web/modules/hydroponics-module/src/pages/pid-simulator/components/SimDeffeyesChart.tsx` (6); `web/shared-ui/src/utils/api-client.ts` (2) |
| `ANTI-14` | anti-patterns | 13 `throw new Error('not implemented')` in 5 admin-panel UI files | `web/modules/admin-panel/src/services/api/security.ts` (6); `analytics.ts` (4); `impersonation.ts` (2); `settings.ts` (1) |
| `ADR-001/002/003-TIER4-HIGH/MEDIUM` | adr-drift | ADRs 001/002/003 are 0-byte files; CLAUDE.md references them as canonical | `docs/adr/001-monorepo-vs-polyrepo.md`, `002-gateway-api-pattern.md`, `003-sensor-service-separation.md` |
| `ADR-006-TIER1-FALSE-POSITIVE` | adr-drift | Branded `EventId` exists but `eventBus.publish()` accepts untyped literals → tier-1 reduces to tier-4 at publisher boundary | `libs/event-contracts/src/base-event.ts:16` + `platform/libs/event-bus/**` |
| `ADR-008-TIER4-MEDIUM` | adr-drift | Layer-2 `@UseGuards(PlatformAdminGuard)` per controller not asserted by any test | `apps/admin-api-service/src/**/controllers/*.ts` |
| `ADR-009-TIER4-HIGH` | adr-drift | No ESLint rule banning raw `fetch()` in admin-panel | `web/apps/admin-panel/.eslintrc.json` |
| `ADR-012-TIER3-HIGH` | adr-drift | ESLint layer missing; only CI + runtime validator fire | `tools/eslint-rules/` absent |
| `ADR-016-TIER4-HIGH` | adr-drift | Phase D (staging) self-identified as single-biggest deploy improvement; still roadmap | `docs/adr/016-deploy-resilience-architecture.md` |

### MEDIUM

Grouped by theme. Individual finding detail in source reports.

- **Observability gaps (4 findings):** DATA-MEDIUM-004 (1/9 event domains validated), PLAT-HIGH-005 projection tail, MT-MEDIUM-002 no per-tenant metrics, EDGE-HIGH-005 no instrument spans. Theme: infrastructure compiled in, not used. See source reports for per-finding detail.
- **Config / secret / PII discipline (6 findings):** PLAT-MEDIUM-001 (notification `Promise.all`), PLAT-MEDIUM-002 (config-service plaintext SECRET history), SEC-MEDIUM-008 (OPA fallback tenantIsolation), SEC-MEDIUM-009 (`as any` in auth), SEC-MEDIUM-010 (defensive `?.` on DI), MT-MEDIUM-001 (impersonation rate-limit Map fallback).
- **Codebase hygiene (5 findings):** ANTI-7 (9 defensive `?.` on DI), ANTI-8 (85 untracked TODOs), ANTI-9 (5 real banned-phrase comments), ANTI-13 (floating-promise via `.catch(() => {})`), ANTI-15 (27 files with file-level `/* eslint-disable */`).
- **Edge hardening (5 findings):** EDGE-MEDIUM-001 (`set_inflight` not explicit), EDGE-MEDIUM-002 (`max_blocking_threads` tight), EDGE-MEDIUM-003 (OPC UA `Arc<Mutex<u32>>` on counters), EDGE-MEDIUM-005 (shutdown broadcast not CancellationToken), EDGE-MEDIUM-006 (3 untracked `tokio::spawn` tasks).
- **Frontend modernization (3 findings):** FE-MEDIUM-001 (PageLoader ARIA), FE-MEDIUM-002 (useTransition unused), FE-MEDIUM-003 (useGraphQL parallel paradigm).
- **Anti-pattern miscellany (3 findings):** ANTI-2 (378 `as unknown as`, most tests), ANTI-12 (2 real `JWT_SECRET` reads — dev-mode + test), ADR-013-TIER3-LOW (RLS bypass coverage gap in 2 workers).

### LOW

Counted only per source (detailed in source reports):

- data: 2 (DATA-LOW-007 test fixtures, DATA-LOW-008 zero @Saga usage)
- platform: 1 (PLAT-LOW-001 Invoice GraphQL Float on Decimal)
- security: 2 (SEC-LOW-011 WS gateway HS256 JSDoc, SEC-LOW-012 CSP report unthrottled)
- frontend: 2 (FE-LOW-001 React.memo single-site, FE-LOW-002 stray @ts-ignore)
- edge: 1 (EDGE-LOW-001 `[lints.rust]` thin)
- multi-tenant: 1 (MT-MEDIUM-003 x-tenant-id header broadly accepted — is actually MEDIUM not LOW)
- anti-patterns: 2 (ANTI-6 backend console clean, ANTI-10 JSON.stringify-indent unhit)
- adr-drift: 3 (ADR-013-TIER3-LOW, ADR-014 NONE-gap, ADR-015-LOW cert CN hand-maintained)

Total LOW count: 14 across slices.

### NEW findings surfaced by meta-synthesis

| ID | Severity | Summary |
|---|---|---|
| `CTX-HIGH-001` | HIGH | `tests/invariants/adoption-invariants.spec.ts` does not exist despite being cited by `_constants.ts:7` and `declarative-riding-shamir.md` BLOCKER-8. The spec file is the structural gate for the `_constants.ts` SSoT; without it, the 13-vs-7 distinction is declared but not enforced. |
| `CTX-MEDIUM-001` | MEDIUM | `e2e/tests/integration/schema-invariants.spec.ts` hardcodes `SHARED_SCHEMA_TABLES` / `ALLOWED_PUBLIC_TABLES` inline rather than importing from `tests/invariants/_constants.ts`. |
| `CTX-MEDIUM-002` | MEDIUM | The frontend slice anchor table and the plan's `claudeMd`-level tech anchor disagree. Part B knowledge authoring MUST cite the corrected table below, not the plan's aspirational anchor. |
| `CTX-MEDIUM-003` | MEDIUM | Finding counts disagree across slices on `@Entity()` without schema (180 vs 21 vs 157). Part D gate infrastructure must standardise one grep methodology (AST-based, not textual) to emit deterministic counts across future cycles. |

---

## Structural vs procedural fixes needed

### Structural (Part B knowledge + Part C skills + Part D gates)

| Systemic pattern | Part B knowledge | Part C skill | Part D gate |
|---|---|---|---|
| SYS-1 Control-plane | "Invariant tier authoring contract" doc | `brand-event-id`, `schema-entity-decorator`, `tenant-query-key-brand`, `enforce-scoped-repository`, `derive-db-key-fail-closed` | `tools/eslint-rules/{require-entity-schema,no-inline-event-literal,no-direct-event-publish,no-raw-redis-on-tenant-data,no-bare-tenant-query-key,require-finding-id-on-todo}` |
| SYS-2 Fail-open | "Fail-closed infra contract" doc | `required-infra-injection`, `stripe-webhook-durable-dedupe` | ESLint `no-in-memory-fallback-on-infra` + bootstrap hard-fail |
| SYS-3 Dead-code defenses | ADR adoption-test contract | `opa-policy-rollout`, `watchdog-module-extraction`, `tenant-erasure-cascade-scaffold` | `adoption-invariants.spec.ts` (CTX-HIGH-001) + CI test asserting every `infra/.*` module has ≥1 adopter |
| SYS-4 Half-migrations | `PLAN-COMPLETION-CHECKLIST.md` format | `plan-closure-manifest` (emits machine-readable checklist) | CI gate refuses to close a plan task unless every listed invariant test passes |
| SYS-5 Observability | `TelemetryContract` per-module authoring guide | `instrument-hot-paths`, `tenant-metric-top-n` | ESLint rule enforcing `@Traced`/`#[instrument]` on hot-path functions listed in `hot-paths.json` |

### Procedural (immediate quick wins outside the plan, fit in W2 side-quest)

| Quick win | Owner | Hours | Rationale |
|---|---|---|---|
| Content 5 empty ADR files (001/002/003) or write 2 supersede ADRs for 004/005 | architectural-arbiter | 4h each | Zero-byte ADRs referenced in CLAUDE.md break audit discipline. ADR-004/005 have no implementation — supersede with "deferred/not-adopted" decision records. |
| Add `schema: 'config'` + change migration runner arg to `'config'` + write `ALTER TABLE … SET SCHEMA config` migration | platform-kernel-expert | 3h | PLAT-CRITICAL-002 is a direct, isolated fix; does not need a full Part B/D rollout to ship safely. |
| Move `cdn.jsdelivr.net` to self-hosted + pin SRI hashes in CSP headers (shell + SCADA) | frontend-expert + edge-expert | 4h joint | FE-HIGH-003 + EDGE-HIGH-002 share the root cause — same CDN in both CSPs. |
| Declare `failover_manager: Option<Arc<FailoverManager>>` on `AppState` + wire init + register shutdown task | edge-expert | 8h | EDGE-CRITICAL-001 blocks deploy from HEAD. This is the "architectural fix takes as long as it takes" path; workaround (return NotImplemented) is banned. |
| Change `scada_db.rs:71` `unwrap_or_else` to `?` with typed error, matching `offline_queue.rs:41-60` | edge-expert | 2h | EDGE-CRITICAL-002 is a single-line change with a same-crate precedent. |
| Add `e2e/tests/integration/schema-invariants.spec.ts` to `import from '../../../tests/invariants/_constants'` | data-expert | 1h | CTX-MEDIUM-001 — close the SSoT-use gap. |
| Populate `tests/invariants/adoption-invariants.spec.ts` with assertions over `SCHEMA_OWNING_SERVICES` ↔ `SchemaDriftModule.forRoot` wiring + `PER_TENANT_SCHEMA_SERVICES` ↔ `createTenantConnectionBootstrap` wiring | data-expert + multi-tenant-saas-expert | 6h | CTX-HIGH-001 — closes the structural gate the SSoT was authored for. |
| Rate-limit `CspReportController` | auth-security-expert | 1h | SEC-LOW-012 — single decorator change, unauthenticated write amplifier. |
| Rewrite JWT/tenant-context middleware logs to structured `Logger.debug('event', {…})` | auth-security-expert | 2h | SEC-HIGH-006 — 3 file edits; unlocks `maskPiiDeep`. |
| Sweep WebSocket gateway HS256 JSDoc → RS256 | auth-security-expert | 1h | SEC-LOW-011 — cosmetic but misleads reviewers. |

Total quick-win budget: ≈ 35h across 6 owners. All fit in W2 without perturbing the Part B/C/D scaffold.

---

## Corrected tech anchor table (for Part B Layer-1 SSoT authoring)

The plan's tech anchor asserts Vite 7.3.1 / React 18.2 / `@nx/module-federation`. Repo reality differs materially. **Part B SSoT documents MUST be written against this corrected table.**

| Anchor | Plan claim | Repo reality | Where |
|---|---|---|---|
| React runtime | 18.2.0 | **18.3.1** (shell), **^18.2.0** (remotes + aquamobil + shared-ui peer) | `web/shell/package.json:19`; `web/shared-ui/package.json:35`; every `web/modules/*/package.json` |
| Vite | 7.3.1 | **^5.0.0** shell + every remote; **^5.4.0** aquamobil | `web/shell/package.json:34`; `web/apps/aquamobil/package.json:38`; every `web/modules/*/package.json` |
| Module Federation | `@nx/module-federation` (assumed) | **`@originjs/vite-plugin-federation ^1.3.5`** (Rspack-style, Vite-native) | every `web/*/vite.config.ts` |
| @nx/react / @nx/vite | 22.3.3 executors | **Nx `nx:run-commands` executors delegating to workspace `npm run dev|build`** — not native `@nx/vite:build` | `web/shell/project.json`; every `web/modules/*/project.json` |
| eslint-plugin-react-hooks | 5.0.0 | Mixed: **5.0.0** in modules/aquamobil; **^4.6.0** in `web/shared-ui/package.json:54` | `web/shared-ui/package.json:54` vs remotes |
| eslint-plugin-react | ^7.33.2 | **^7.33.0** in shared-ui | `web/shared-ui/package.json:53` |
| TypeORM | 0.3.27 | **^0.3.27** confirmed | root `package.json` |
| @nestjs/typeorm | 11.0.0 | **11.0.0** confirmed | root `package.json` |
| @nestjs/cqrs | 11.0.3 | **11.0.3** confirmed | root `package.json` |
| NestJS core | 11.1 (assumed) | **11.1.17** confirmed | root `package.json` |
| Tokio | 1.43 | **1.43** confirmed | `sens-api-gateway/Cargo.toml:39` |
| axum | 0.8 | **0.8** confirmed | `sens-api-gateway/Cargo.toml` |
| rustls-native-certs | 0.8 | **0.8** confirmed | `sens-api-gateway/Cargo.toml` |
| thiserror | 2.0 | **2.0** confirmed | `sens-api-gateway/Cargo.toml:29` |

**Authoring instruction for Part B:** When referencing frontend build tooling, write to Vite 5 APIs, `@originjs/vite-plugin-federation`, and acknowledge the shared-ui react-hooks lockstep gap as a precondition. Do NOT author skills against Vite 7 HMR, React 19 Server Actions, or @nx/module-federation — those would ship dead knowledge. Backend tech anchors (TypeORM 0.3.27 / NestJS 11.1 / CQRS 11) match the plan claim and can be taken as authoritative. Edge tech anchors (Tokio 1.43 / axum 0.8 / thiserror 2.0 / rustc 1.85 / edition 2024) match and are authoritative.

---

## Plan revision recommendations (before W2 kickoff)

1. **BLOCKER-8 count:** update the plan's amendment language from "13 vs 9" to include the 157 `@Entity()`-missing-schema count as the actual W2 workload scale. The "13 services own schemas" SSoT is correct and already landed; the entity-level ADR-011 compliance work is the larger block.
2. **Rescind MT-HIGH-001 escalation:** `tests/invariants/_constants.ts` exists. Keep MT-CRITICAL-001 through MT-CRITICAL-004 as-is; they are orthogonal.
3. **Promote CTX-HIGH-001 into W2 scope:** `adoption-invariants.spec.ts` must land alongside any Part B agent-knowledge publication. Without it, the SSoT is declared-not-enforced.
4. **Rewrite the tech anchor table in AMENDMENT-B** to cite the corrected values above. Frontend skills and knowledge authored against Vite 7 will not apply.
5. **Add a "structural vs procedural" split to the W2 intake:** the 5 systemic patterns (SYS-1 to SYS-5) are the Part B/C/D load-bearing artefacts; the 10-quick-wins are W2 side-quest. The plan currently conflates them.
6. **ADR-004 + ADR-005 supersede work** must land in W2, not W4+. Leaving "Accepted" ADRs with no implementation corrupts every downstream knowledge authoring pass.
7. **Add `tools/eslint-rules/` workspace bootstrap as W2 pre-req** — the three ADR-012 / ADR-011 / event-contract lint rules are the skeleton for Part D. The directory does not exist yet; standing it up is the smallest first step.
8. **Frontend `eslint-plugin-react-hooks` lockstep** (FE-HIGH-004) — track as a pre-requisite Part C skill: `align-shared-ui-lint-versions`. Without it, Part D hooks-v5 rules will not fire in shared-ui (the highest-leverage workspace).
9. **EDGE-CRITICAL-001 compile break** is a stop-the-line item for W2. The plan should schedule it in the first 48h, not interleaved with knowledge/skill work.
10. **Boundary-files allowlist** (this cycle's AMENDMENT-B) must be read by the planned new ESLint rules from day 1. The seed file is delivered alongside this unified audit.

---

## Surprises and insights

1. **Backend `console.*` discipline is clean** — ANTI-6 surprise. ESLint rule effective. The `web/**` story is inverted — 825 `console.*` hits concentrated in admin-panel. Part D must replicate the rule to `web/**` before any web refactor lands.
2. **`JWT_SECRET` reads in production are effectively zero** — ANTI-12 + SEC-A1. ADR-016 Phase B migration is complete. This is the cleanest signal in the audit; treat it as the template for what Part B/C/D are trying to achieve for the other invariants.
3. **Two orthogonal replay surfaces** in the HMAC chain (SEC-HIGH-002 + SEC-HIGH-003) — both the outbound signer and the inbound verifier have weak canonical inputs. They must be fixed in one joint commit; fixing only one leaves the system equally vulnerable.
4. **SCADA + shell CSP both whitelist the same CDN** — EDGE-HIGH-002 + FE-HIGH-003. A single cross-domain action (self-host or SRI-pin) closes two findings.
5. **Watchdog is the only active cross-tenant leak canary, and it's in one service** (MT-HIGH-004). On any tenant leak in the other 6 schema-per-tenant services, detection waits for the next manual review — a monitoring gap larger than the isolation gap itself.
6. **OPA full stack exists + is fail-closed + has zero adopters** (SEC-HIGH-004). This is the pattern-instance of SYS-3. The decision — land or delete — should be made by architectural-arbiter in W2 before Part C skills reference authorization policies.

---

## Report manifest

| Metric | Value |
|---|---|
| BUDGET_STATUS | COMPRESSION_RECOMMENDED (input ~45K tokens, output ~10K) |
| ESTIMATED_INPUT_TOKENS | ~45,000 (8 slices × ~5-8K each) |
| CONSOLIDATION_OUTPUT_TOKENS | ~10,200 |
| COMPRESSION_RATIO | ~4.4× |
| REPORT_COUNT | 8 slices + 1 unified (this) |
| OLDEST_REPORT_DATE | 2026-04-16 (all slices produced this cycle) |
| NEWEST_REPORT_DATE | 2026-04-16 |
| CRITICAL findings total | 18 |
| HIGH findings total | 38 |
| MEDIUM findings total | ~26 (grouped) |
| LOW findings total | 14 |
| NEW context-manager findings | 4 (CTX-HIGH-001, CTX-MEDIUM-001/002/003) |

---

## References

- All 8 slice reports at `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-*.md`
- `/var/aqua-saas/tests/invariants/_constants.ts` (verified present, 76 lines, commit `ad7ec82d`)
- `/var/aqua-saas/CLAUDE.md` (review traceability, architectural approach)
- `/root/.claude/plans/declarative-riding-shamir.md` (Part A.4, AMENDMENT-B)
- Boundary allowlist seed: `/var/aqua-saas/.claude/allowlists/boundary-files.yaml` (this cycle)
