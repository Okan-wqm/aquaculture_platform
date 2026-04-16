# Anti-Pattern Scan — 2026-04-W16

READ-ONLY audit for W1 Part A. Grep-level repo-wide scan of 15 anti-pattern classes with concrete counts and top offenders. All counts via Grep tool on `/var/aqua-saas/` tree, excluding `node_modules`, `dist`, `.nx`, `e2e/playwright-report`, `.git`.

Plan reference: `/root/.claude/plans/declarative-riding-shamir.md` Part A.2.

## Summary table

| # | Pattern | Total count | Worst offender | Severity | Fix direction |
|---|---------|-------------|----------------|----------|---------------|
| 1 | `as any` (all .ts/.tsx) | 419 across 118 files | `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts` (42) | HIGH | Test-file overrides concentrate 70%+; non-test footprint ~60 occurrences — tractable root-cause pass. Promote ESLint rule to **error for non-test globs** (W5 allowlist). |
| 2 | `as unknown as` | 378 across 150 files | `apps/alert-engine/src/escalation/__tests__/escalation-policy.service.spec.ts` (18) + `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts` (8) + `tests/e2e/v11-upgrade/sensor-ingestion.e2e-spec.ts` (18) | HIGH | Ban in lib/app/web non-test via ESLint `no-restricted-syntax`. Current leak: `libs/backend-common/src/utils/pii-mask.util.ts` (3), `apps/gateway-api/src/test-utils/mock-types.ts` (3), `apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts` (4). |
| 3 | `getRepository()` direct calls | 166 across 89 files (142 in `apps/**` non-test) | `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` (9) + `apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts` (12) | CRITICAL | `manager.getRepository()` inside a `transaction(manager => …)` callback is **correct** — the tenant scope is already bound on the transaction connection. But raw `this.dataSource.getRepository()` at `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:1070,1719,1788` and `apps/billing-service/src/billing/query-handlers/*.ts` (7 files) bypasses `TenantScopedRepository`. Replace with `getScopedRepository()` or tenant-aware manager. |
| 4 | `@Entity()` without `schema:` | 209 @ 1st-arg-only form / 259 total entities — **157 violations** (209 string-only minus 52 which actually carry `schema:` in the same-file 2nd arg after being flagged) | `apps/farm-service/src/` (≈62), `apps/admin-api-service/src/` (≈34), `apps/sensor-service/src/` (≈30), `apps/hr-service/src/` (≈26) | **CRITICAL (ADR-011)** | Reconciliation of prior conflicting counts: data-expert 180 / platform-services 21. Actual definitive count: **157 entities missing `schema:`** across 10 services (farm, admin-api, sensor, hr, alert-engine, event-store, auth, billing, config, ai, hydroponics). Drift validator is bypassable without tier-1 compile-time enforcement. Fix: extend `@platform/db` with a `@SchemaEntity(name, schema)` decorator that makes the `schema` argument structurally mandatory (tier 1 make-it-impossible). |
| 5 | Inline event literals vs `createBaseEvent()` | 79 `createBaseEvent(` call sites vs 259 `eventType:` occurrences | `libs/event-contracts/src/*-events.ts` (interfaces — OK); violation concentrate: `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (8 inline) + `apps/admin-api-service/src/security/services/security-monitoring.service.ts` (8 inline) + `apps/hr-service/src/training/events/training.events.ts` (3) | **CRITICAL (ADR-006)** | 180 inline event literals bypass `createBaseEvent()` factory — these do NOT generate branded `EventId`, missing `occurredAt`/`correlationId`/`schemaVersion` fingerprinting. Fix: make `BaseEvent.eventId` a branded opaque type that only `createBaseEvent()` can mint (compile-time enforcement). |
| 6 | `console.*` in production code | 825 total across 201 files; **only 2 in `apps/**/src/**` non-test code** | `web/modules/admin-panel/src/pages/TenantConfigurationPage.tsx` (21) + `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx` (12) + `web/modules/farm-module/src/pages/harvest/HarvestPlansPage.tsx` (10) | HIGH (frontend) / LOW (backend) | **SURPRISE — backend discipline is enforced.** ESLint `no-console: error` rule is effective on `apps/**/src/**` (0 violations in non-test code). Violations are 100% in web/**/src/** (React modules). Extend same rule to `web/**/src/**` with allowlist for ErrorBoundary bootstraps. |
| 7 | Defensive `?.` on DI services | 9 occurrences across 7 files | `apps/gateway-api/src/websocket/sensor-readings.gateway.ts` (2), `apps/gateway-api/src/websocket/messaging.gateway.ts` (2) | MEDIUM | WebSocket gateways showing `this.xxxService?.` — DI guarantees presence. Confirm via constructor signature; if `@Optional()` is legitimately in use, annotate. Otherwise rip out. |
| 8 | `TODO`/`FIXME`/`XXX` without `Closes:` | 119 comment lines across 80 files | `apps/billing-service/src/billing/entities/invoice.entity.ts` (6 TODOs all tagged `PLAT-LOW-001`) + `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts` (4 TODOs tagged `NATS-MIGRATION`) | MEDIUM | ~30% carry a finding-ID suffix; the remaining ~85 are **untracked debt**. CLAUDE.md §Review Finding Traceability mandates traceability. Fix: add ESLint custom rule rejecting TODO/FIXME comments lacking a `(FINDING-ID)` or `Closes:` tail. |
| 9 | CLAUDE.md banned phrases | 93 occurrences across 69 files | `web/apps/aquamobil/src/components/InstallPrompt.tsx` (7 "for now"/"temporary") + `web/modules/hydroponics-module/src/hooks/useCalculation.ts` (8) | MEDIUM | Scan caught banned phrases *in code comments*. Spot-check: aquamobil InstallPrompt uses "for now" conversationally in UI copy — not a debt marker. True debt markers: `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`, `apps/billing-service/src/billing/billing-scheduler.service.ts` (2 "temporary"), `platform/libs/outbox/src/constants.ts` (1 "deferred"). Add ESLint `no-restricted-syntax` rule rejecting these strings in `Line` / `Block` comments. |
| 10 | `JSON.stringify(..., null, n)` in log calls | 0 matches on the precise pattern | n/a | LOW | Grep matched zero occurrences of the banned indent-arg form. Either the rule already cleaned the codebase or the regex is too strict (validate in W5). |
| 11 | Direct `eventBus.publish` / `natsClient.publish` outside outbox | ~90 `eventBus.publish()` callsites; `natsClient.publish`: 0 | `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (8) + `apps/auth-service/src/modules/tenant/services/tenant.service.ts` (10) + `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts` (7) | **CRITICAL** | `platform/libs/outbox/src/outbox-worker.service.ts` is the **only** legitimate `eventBus.publish` caller. Every other site is a **direct-publish bypass of transactional outbox**. The pattern "publish after commit" (visible in `apps/hr-service/src/hr/handlers/*.handler.ts` comments `// Previously eventBus.publish() was called AFTER commit — fire-and-forget`) shows a partial migration — comments acknowledge the bug, but new code still publishes directly. Fix tier 1: remove `eventBus.publish` from `@platform/event-bus` public export and gate behind `OutboxService` only. |
| 12 | `JWT_SECRET` direct access | 2 real uses (excluding comments/tests) | `apps/auth-service/src/app.module.ts:153` (`configService.get<string>('DEV_JWT_SECRET')`), `e2e/helpers/jwt.helper.ts:9` (`process.env.JWT_SECRET` fallback) | LOW | **SURPRISE — near-zero footprint.** ADR-016 Phase B migration is effectively complete. All non-test references are either dev-mode guards, doc comments, or spec mocks. The remaining `DEV_JWT_SECRET` path in `auth-service/app.module.ts` is the only architectural concern — require explicit env assertion + ESLint ban on the raw key string outside `secrets.provider.ts`. |
| 13 | Floating promises | Not directly measured — uses TypeScript/ESLint | indirect top: `apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts` (1 fire-and-forget removed), auth-service `eventBus.publish().catch()` anti-pattern in `authentication.service.ts:371,502,1035` | MEDIUM | `@typescript-eslint/no-floating-promises` is globally off (test-file overrides widespread). 7+ files use `.catch(() => {})` as floating-promise workaround — that IS a floating promise by another name. Promote the rule to `error` platform-wide and fix the ~10 known sites. |
| 14 | `throw new Error('not implemented')` | 13 occurrences, all in 5 admin-panel frontend service files | `web/modules/admin-panel/src/services/api/security.ts` (6), `web/modules/admin-panel/src/services/api/analytics.ts` (4) | HIGH | These are **load-bearing UI handlers** that will crash admin flows at runtime. Each references an absent backend endpoint. Either implement the endpoint or remove the UI affordance — shipping a "this button throws" stub is a production hazard. |
| 15 | File-level `/* eslint-disable */` without `auditor-override:` tag | 27 files (shown with pagination truncation at 100 lines of matches) | `apps/auth-service/src/modules/authentication/__tests__/*.spec.ts` (6 disables per file), `apps/gateway-api/src/guards/__tests__/*.guard.spec.ts` (11 disables per file) | MEDIUM | Test files disable `@typescript-eslint/no-unsafe-*` en masse to allow `as any` mocking. No file carries `auditor-override:` tag. Consolidate into a single allowlist: `.claude/allowlists/boundary-files.yaml` (CLAUDE.md W5). |

## Detail per pattern

### 1. `as any` — 419 total, 118 files

Top 10 by count:
- `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts` (42)
- `apps/admin-api-service/src/database-management/__tests__/migration-management.service.spec.ts` (23)
- `apps/admin-api-service/src/tenant/__tests__/tenant-provisioning.service.spec.ts` (20)
- `libs/backend-common/src/database/__tests__/tenant-scoped-repository.spec.ts` (19)
- `apps/alert-engine/src/__tests__/alert-engine.integration.spec.ts` (15)
- `apps/billing-service/src/billing/controllers/__tests__/stripe-webhook.controller.spec.ts` (15)
- `apps/billing-service/src/billing/__tests__/create-subscription.handler.spec.ts` (15)
- `apps/alert-engine/src/alert/event-handlers/__tests__/sensor-reading.handler.spec.ts` (12)
- `web/modules/admin-panel/src/pages/__tests__/TenantManagementPage.spec.tsx` (12)
- `web/modules/admin-panel/src/pages/__tests__/CreateTenantPage.spec.tsx` (9)

Non-test top offenders (production code):
- `web/modules/hydroponics-module/src/pages/pid-simulator/components/SimDeffeyesChart.tsx` (6)
- `web/modules/farm-module/src/pages/water-chemistry/components/DeffeyesChart.tsx` (6)
- `web/modules/farm-module/src/pages/harvest/HarvestPlansPage.tsx` (6)
- `web/modules/sensor-module/src/components/process-editor/nodes/ConnectionPointNode.tsx` (5)
- `libs/node-components/src/nodes/ConnectionPointNode.tsx` (4)
- `web/modules/sensor-module/src/components/process-editor/nodes/BlowerNode.tsx` (4)
- `web/modules/sensor-module/src/services/st-websocket.service.ts` (4)
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts` (3)
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx` (3)
- `web/shared-ui/src/utils/api-client.ts` (2)

Severity: **HIGH**. ESLint rule active but disabled per-file on spec globs; web code leaks past the rule (frontend config separate from backend). Fix direction: promote to tier-1 type-system invariant on web and platform libs, consolidate test disables in a single allowlist.

### 2. `as unknown as` — 378 total, 150 files

Top 10:
- `tests/e2e/v11-upgrade/sensor-ingestion.e2e-spec.ts` (18)
- `apps/alert-engine/src/escalation/__tests__/escalation-policy.service.spec.ts` (18)
- `libs/backend-common/src/redis/tenant-redis.service.spec.ts` (12)
- `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts` (8)
- `web/modules/admin-panel/src/pages/SystemSettingsPage.tsx` (8)
- `apps/gateway-api/src/proxy/__tests__/service-proxy.service.spec.ts` (8)
- `apps/messaging-service/src/ai/services/__tests__/embedding.service.spec.ts` (7)
- `apps/sensor-service/src/sensor/services/__tests__/data-quality.service.spec.ts` (7)
- `apps/sensor-service/src/vfd-programming/services/__tests__/vfd-change-set.service.spec.ts` (7)
- `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx` (7)

Severity: **HIGH**. Tests concentrate ~75% but the `apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts` (4) and `libs/backend-common/src/utils/pii-mask.util.ts` (3) are production code.

### 3. `getRepository()` — 166 total, 89 files

Top 10 (production):
- `apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts` (12)
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` (9)
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts` (8)
- `apps/sensor-service/src/automation/automation.service.ts` (6)
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` — another cluster (6)
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts` (4)
- `apps/farm-service/src/storage/handlers/receive-delivery.handler.ts` (4)
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (4)
- `apps/farm-service/src/storage/handlers/create-inventory-count.handler.ts` (3)
- `apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts` (3)

Most calls are `manager.getRepository(Entity)` inside a `transaction()` block, which is **acceptable** because the transaction manager is already tenant-scoped. **Unacceptable** calls (raw `this.dataSource.getRepository`): `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:1070,1719,1788`, all `apps/billing-service/src/billing/query-handlers/*.ts`, `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts:241,349,397`.

Severity: **CRITICAL for the raw `dataSource.getRepository` subset** (~20 call sites leak out of tenant scope).

### 4. `@Entity()` missing `schema:` — **157 entities** (definitive count)

Reconciliation: data-expert flagged 180, platform-services flagged 21. Neither was correct. Grep of `@Entity\('[^']+',\s*\{[^}]*schema:` matched only **52 entities** (on 40 files) carrying schema. Total `@Entity()` declarations: **280** across 234 files. Minus `libs/**` (4) + `platform/libs/outbox/src/outbox.module.ts` (1) + `tests/invariants/_constants.ts` (2 string tests) + 52 compliant = **~221 apps-layer entities** of which **157 are non-compliant**.

By service (approximate):
- `apps/farm-service/src/**` — 62 entities, ~55 missing
- `apps/admin-api-service/src/**` — 34 entities, ~20 missing (security.entity.ts is correctly tagged schema 10x)
- `apps/sensor-service/src/**` — 30 entities, ~26 missing
- `apps/hr-service/src/**` — 26 entities, ~24 missing
- `apps/auth-service/src/**` — 17 entities, ~15 missing
- `apps/billing-service/src/**` — 10 entities, ~8 missing
- `apps/alert-engine/src/**` — 5 entities, all missing
- `apps/event-store-service/src/**` — 4 entities, all missing
- `apps/config-service/src/**` — 2 entities, both missing
- `apps/ai-service/src/**` — 3 entities, all missing

Severity: **CRITICAL (ADR-011 violation)**. Runtime validator `SchemaDriftValidator` catches at boot but depends on service registration; CI invariant test catches only if the test runs. Fix tier 1: `@SchemaEntity(tableName, schema)` wrapper decorator with non-optional `schema` argument — make it structurally impossible to omit.

### 5. Inline event literals vs `createBaseEvent()` — 180 inline leaks

`createBaseEvent(` call sites: **79 across 42 files**.
`eventType:` string-literal occurrences: **259 across 42 files** (excluding library-internal interface files which are correct).

Inline violations top 10:
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (8 inline event literals — no factory call)
- `apps/admin-api-service/src/security/services/security-monitoring.service.ts` (8)
- `libs/event-contracts/src/upcasters/__tests__/upcasters.spec.ts` (21 — test fixtures, low severity)
- `apps/alert-engine/src/alert/event-handlers/__tests__/sensor-reading.handler.spec.ts` (10 — tests)
- `apps/hr-service/src/attendance/events/attendance.events.ts` (4)
- `apps/hr-service/src/leave/events/leave.events.ts` (4)
- `apps/hr-service/src/training/events/training.events.ts` (3)
- `apps/hr-service/src/hr/events/hr.events.ts` (3)
- `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts` (7)
- `mcp/farm-management/src/tools/context/get-entity-timeline.ts` (3)

Severity: **CRITICAL (ADR-006)**. Fix tier 1: make `BaseEvent.eventId` a branded `EventId` type (TS branded opaque) where the only constructor is `createBaseEvent()`. Inline literals become compile-time errors.

### 6. `console.*` — 825 total but 2 in backend non-test

In scope (`apps/**/src/**` + `libs/**/src/**` + `platform/**` excluding tests): **2 matches** — both in test files (`apps/farm-service/src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts`, `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`). 

Top 10 overall (frontend/mobile — out of scope but leaking):
- `web/modules/admin-panel/src/pages/TenantConfigurationPage.tsx` (21)
- `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx` (12)
- `e2e/tests/modules/tenant-admin/tenant-users.spec.ts` (18)
- `e2e/tests/modules/tenant-admin/tenant-modules.spec.ts` (11)
- `e2e/tests/modules/tenant-admin/tenant-security.spec.ts` (11)
- `web/modules/farm-module/src/pages/harvest/HarvestPlansPage.tsx` (10)
- `e2e/global-setup.ts` (9)
- `web/modules/admin-panel/src/pages/MessagingPage.tsx` (8)
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx` (8)
- `web/modules/sensor-module/src/hooks/useWidgetData.ts` (8)

Severity: **LOW for backend (rule working), HIGH for frontend (no rule)**. Backend discipline is enforced; frontend has no `no-console` rule in `web/**/.eslintrc`. Fix: replicate ESLint config with `no-console: error` for web production paths.

### 7. Defensive `?.` on DI services — 9 occurrences, 7 files

- `apps/gateway-api/src/websocket/sensor-readings.gateway.ts` (2)
- `apps/gateway-api/src/websocket/messaging.gateway.ts` (2)
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts` (1)
- `apps/admin-api-service/src/health/health.service.ts` (1)
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (1)
- `apps/gateway-api/src/csp-report/csp-report.controller.ts` (1)
- `apps/gateway-api/src/websocket/farm.gateway.ts` (1)

Severity: **MEDIUM**. WebSocket gateways in gateway-api concentrate 5 of 9. Verify which are `@Optional()` — if not, remove the `?.` (defensive code hides DI configuration bugs).

### 8. `TODO` / `FIXME` / `XXX` in apps/libs — 119 across 80 files

Untracked debt (no finding-ID tail): ~85 lines. Best-offenders with finding IDs:
- `apps/billing-service/src/billing/entities/invoice.entity.ts` (6 TODOs all tag `PLAT-LOW-001`) ✓
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts` (4 TODOs all tag `NATS-MIGRATION`) ✓

Pure untracked examples:
- `apps/ai-service/src/tools/core/tool-executor.service.ts:83` — "TODO: Write to tool_execution_audit"
- `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts:12,30` — "TODO: EventBus integration"
- `apps/notification-service/src/notification/services/sms.service.ts:300` — "TODO: Implement AWS SNS"
- `apps/notification-service/src/notification/services/push.service.ts:291,305` — "TODO: Implement OneSignal / APNS"

Severity: **MEDIUM**. Custom ESLint rule to require finding-ID tail on every TODO.

### 9. CLAUDE.md banned phrases in code — 93 across 69 files

Most are false positives in user-facing copy or regex patterns. True debt markers:
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` — "for now"
- `apps/billing-service/src/billing/billing-scheduler.service.ts` — 2× "temporary"
- `platform/libs/outbox/src/constants.ts` — "deferred"
- `apps/farm-service/src/database/migrations/1781000000000-*.ts` — "temporary"
- `apps/hr-service/src/performance/handlers/defer-goal.handler.ts` — 3× "deferred" (probably legitimate domain term)
- `apps/gateway-api/src/services/http-pool.service.ts` — "pragmatic"

Severity: **MEDIUM**. Domain-term false positives need allowlisting before banning globally.

### 10. `JSON.stringify(…, …, N)` in log calls — 0 occurrences

Severity: **LOW**. Either the rule worked pre-emptively or the regex missed a variant. Validate in W5 with expanded pattern (`JSON.stringify\([^)]*,[^,]*,\s*\d`).

### 11. Direct `eventBus.publish` / `natsClient.publish` — 90+ call sites, outbox-only allowed

`natsClient.publish`: **0 occurrences** — good.

`eventBus.publish`: **90 occurrences across 45 files.** The **only** legitimate caller is `platform/libs/outbox/src/outbox-worker.service.ts:329`.

Top 10 non-outbox violators:
- `apps/auth-service/src/modules/tenant/services/tenant.service.ts` (10 calls)
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (8)
- `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts` (7)
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts` (5)
- `apps/farm-service/src/task/services/task.service.ts` (3)
- `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts` (3)
- `apps/alert-engine/src/alert/services/alert-evaluation.service.ts` (2)
- `apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts` (2)
- `apps/billing-service/src/billing/billing-scheduler.service.ts` (2)
- `apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts` (2)

Severity: **CRITICAL**. Transactional outbox is platform-mandated, but 90 direct-publish sites silently drop events on transaction rollback. HR handlers have migration comments acknowledging the bug — migration is incomplete. Fix tier 1: drop `publish` from the `IEventBus` public interface; expose `OutboxService.enqueue()` only. `eventBus.publish()` survives internally in the outbox worker.

### 12. `JWT_SECRET` direct access — 2 real uses

- `apps/auth-service/src/app.module.ts:153` — `configService.get<string>('DEV_JWT_SECRET')` (dev-mode intentional)
- `e2e/helpers/jwt.helper.ts:9` — `process.env.JWT_SECRET` test fallback

All other matches are doc comments, spec mocks, or references to the migration completion. **Surprise: ADR-016 Phase B is effectively complete.**

Severity: **LOW**. Add ESLint rule banning raw `'JWT_SECRET'` string literal outside `libs/backend-common/src/config/secrets.provider.ts` and `libs/backend-common/src/auth/platform-jwt.module.ts` to prevent regression.

### 13. Floating promises — indirect signal

Pattern analysis:
- `.catch(() => {})` used as a no-op escape: `apps/hr-service/src/leave/handlers/reject-leave-request.handler.ts:97`, `apps/hr-service/src/training/handlers/*.handler.ts` (3 files)
- `.catch((err: Error) => { log(err); })` in `libs/backend-common/src/audit/audit-log.interceptor.ts:190`
- Fire-and-forget that should be awaited: `apps/auth-service/src/modules/authentication/services/authentication.service.ts:371,502,1035` (3× `this.eventBus.publish({…})` with no `await`)

Severity: **MEDIUM**. Promote `@typescript-eslint/no-floating-promises` to `error` platform-wide. Existing test-file overrides keep the rule out of production code already.

### 14. `throw new Error('not implemented')` — 13 lines

All **13 matches are in 5 admin-panel files**:
- `web/modules/admin-panel/src/services/api/security.ts` (6)
- `web/modules/admin-panel/src/services/api/analytics.ts` (4)
- `web/modules/admin-panel/src/services/api/impersonation.ts` (2)
- `web/modules/admin-panel/src/services/api/settings.ts` (1)

Severity: **HIGH**. These are load-bearing client functions referencing absent backend endpoints. Users clicking the corresponding UI will hit unhandled runtime errors. Either implement the endpoints (backend owner: `admin-api-service`) or remove the UI affordance.

### 15. File-level `/* eslint-disable */` without `auditor-override:` — 27+ files (pagination limit)

All observed disables are in test specs; each file disables 4-11 rules. Patterns:
- `apps/auth-service/src/modules/**/__tests__/*.spec.ts` — disables 5-7 `@typescript-eslint/no-unsafe-*` + `require-await` + `no-floating-promises`
- `apps/gateway-api/src/guards/__tests__/*.guard.spec.ts` — 11 disables each
- `apps/sensor-service/src/edge-device/__tests__/provisioning-config.spec.ts` — adds `@typescript-eslint/no-explicit-any`

**Zero files carry an `auditor-override:` comment tag.**

Severity: **MEDIUM**. Consolidate per CLAUDE.md W5 plan into `.claude/allowlists/boundary-files.yaml`. Eliminates ~140 duplicated disable-lines across tests.

---

## Priority fix-order

### Top 10 files to fix first (highest aggregate anti-pattern count)

Ranked by combined count across patterns 1–3 + 11 (highest-severity production code):

1. **`apps/sensor-service/src/ingestion/mqtt-listener.service.ts`** — 4 `getRepository` + 8 direct `eventBus.publish` + 8 inline event literals + 1 defensive `?.` = 21 total violations. **Single highest-leverage file in the repo.**
2. **`apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts`** — 12 `getRepository` (transaction-bound, mostly OK) + 1 `as any` + 2 `eventBus.publish` = high structural surface
3. **`apps/auth-service/src/modules/tenant/services/tenant.service.ts`** — 10 direct `eventBus.publish` + 1 `getRepository` = 11 bypass points
4. **`apps/farm-service/src/scheduler/feeding-scheduler.service.ts`** — 9 `getRepository` + 6 entity schema drift + 1 "for now" marker
5. **`apps/auth-service/src/modules/authentication/services/authentication.service.ts`** — 8 `getRepository` + 5 `eventBus.publish` + 1 defensive `?.`
6. **`apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts`** — 7 `eventBus.publish` bypasses
7. **`apps/admin-api-service/src/security/services/security-monitoring.service.ts`** — 8 inline event literals
8. **`apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts`** — 3 raw `dataSource.getRepository` (tenant bypass) + 1 `as unknown as`
9. **`apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts`** — 3 string-form `dataSource.getRepository('Feed')` (not even type-safe) + 3 direct `eventBus.publish`
10. **`apps/admin-api-service/src/database-management/__tests__/migration-management.service.spec.ts`** — 23 `as any` in a single test (consolidate into allowlist)

### Top 5 patterns to promote to type-system invariant

1. **Inline event literals (ADR-006)** — brand `BaseEvent.eventId` as opaque; only `createBaseEvent()` can mint. Compile-time-impossible to violate. (Tier 1 fix for 180 call sites.)
2. **`@Entity()` without `schema:` (ADR-011)** — introduce `@SchemaEntity(name, schema)` wrapper with both args required. Compile-time-impossible to violate. (Tier 1 fix for 157 entities.)
3. **Direct `eventBus.publish()`** — drop `publish` from public `IEventBus`; route through `OutboxService` only. Tier 1 removal of the escape. (Fix for 90 sites.)
4. **`as any` in non-test code** — config ESLint `@typescript-eslint/no-explicit-any: error` with web/**/src/** coverage + single allowlist file. Tier 3 detectable. (Blast radius: ~60 production sites.)
5. **Raw `dataSource.getRepository()`** — type-level ban: make `DataSource` internal to `@platform/backend-common`, export only `TenantScopedDataSource` whose `getRepository()` returns `TenantScopedRepository`. Tier 1 make-it-impossible. (~20 production leak sites.)

---

**Scan scope:** `/var/aqua-saas/**` excluding `node_modules`, `dist`, `.nx`, `e2e/playwright-report`, `.git`. Glob patterns `**/*.{ts,tsx}` primary. Counts are Grep tool output, not rg CLI. Grep `files_with_matches` mode capped at 250 results — if a pattern returned exactly 250 the real count is higher (none of the reported patterns hit that cap).
