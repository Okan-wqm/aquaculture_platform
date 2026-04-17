# W1 Part A — Backend/Data Layer Discovery Audit

**Date:** 2026-04-16
**Agent:** data-expert
**Scope:** TypeORM 0.3.27, @Entity schema compliance (ADR-011), migrations discipline (ADR-012), event contracts (ADR-006), outbox pattern (`platform/libs/outbox`), NATS event-layer (ADR-014/015), @nestjs/cqrs 11.0.3 command/query/event bus usage.
**Mode:** READ-ONLY discovery. No source modifications. Tables + finding IDs per CLAUDE.md traceability convention.

Canonical versions (root `package.json`): `typeorm@^0.3.27`, `@nestjs/typeorm@11.0.0`, `@nestjs/cqrs@11.0.3`.

---

## Table 1 — Pattern Usage (slice-wide inventory)

| Pattern | Usage count (approx) | Version-correctness | Example file | Modernization opportunity |
|---|---|---|---|---|
| `DataSource` import (TypeORM 0.3 API) | ~250 files under `apps/` | MODERN — TypeORM 0.3 canonical API | `libs/backend-common/src/database/typeorm-config.factory.ts` | None. Legacy `Connection` API is effectively eradicated in backend code. |
| Legacy `Connection` import / `.getConnection()` | 1 hit, **frontend only** (`web/modules/sensor-module/src/store/processStore.ts`) | N/A — not a TypeORM `Connection` (distinct symbol) | — | No backend debt. |
| `getScopedRepository()` (tenant-safe) | ~71 occurrences across 31 files (incl. `libs/backend-common/src/database/tenant-scoped-repository.ts`) | MODERN — recommended path | `libs/backend-common/src/database/tenant-aware.repository.ts:50` | Widen ESLint rule to ban `manager.getRepository(...)` inside `dataSource.transaction(...)` callbacks (155 raw-`getRepository` hits in apps — most are legitimate transactional callbacks, see Table 2). |
| Raw `getRepository(...)` — auth transactional callbacks + leak cases | 155 matches across 83 files; ~4 confirmed non-transactional leaks (config-service handlers, farm outbox, etc.) | MIXED | `apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts:30` | ESLint rule currently matches lexically; it misses `manager.getRepository`. Tighten. |
| `@Entity('x', { schema: '<svc>' })` (ADR-011 compliant) | ~28 files (out of ~209 entity declarations) | PARTIAL — minority | `apps/messaging-service/src/message/entities/message.entity.ts:31`, `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:48` | See DATA-HIGH-001: 180 bare `@Entity('name')` declarations lack explicit `schema:` — they work only because `createServiceTypeOrmConfig` injects a default. ADR-011 requires the decorator to declare it. |
| `SchemaDriftModule.forRoot({ serviceName })` wired in `app.module.ts` | 12/12 database-owning services | MODERN — full coverage | `apps/farm-service/src/app.module.ts:379` | None. |
| `createMigrationRunnerService('<schema>')` registered in AppModule | 8 explicit services (ai, alert, billing, config, farm, hr, messaging, notification); sensor/admin-api/auth/event-store use platform runner + per-service migration dir | MODERN | `apps/farm-service/src/database/services/migration-runner.service.ts:14` | Converge last 4 services onto the factory. `apps/db-migrate/` orchestrator is the long-term replacement (Phase 1 noted in its main.ts comment). |
| Events constructed via `createBaseEvent()` | ~278 call sites across 104 files | MODERN — branded `EventId` compile-time gate enforced | `apps/farm-service/src/batch/handlers/create-batch.handler.ts` | `createBaseEvent` return type can migrate to `satisfies` pattern for downstream inference (see Table 3, row 1). |
| Inline event-object literals (`{ eventId: crypto.randomUUID(), ... }`) in production code | 0 in production; 13 in `tests/e2e/v11-upgrade/*` test fixtures (intentional, cross-version replay) | COMPLIANT | `tests/e2e/v11-upgrade/nats-crossversion.e2e-spec.ts:151` | Branded `EventId` makes this a compile error in prod code. Test fixtures use `as EventId` casts — acceptable but should be wrapped in a `mkFixtureEvent()` helper. |
| Upcaster coverage for versioned events | 3 upcaster files + 4 timestamp-bump wrappers = 7 registered | MODERN | `libs/event-contracts/src/upcasters/index.ts` | Upcaster test fixtures live in `__tests__/` — verify 1:1 coverage for each v1→v2 transition (see Table 3, row 3). |
| JSON Schema validators (trust-boundary) | 1 bounded domain validated: `validateFarmEvent` (`libs/event-contracts/src/schemas/farm-events.schema.ts`) | PARTIAL | `libs/event-contracts/src/schemas/validator.ts` | DATA-MEDIUM-004: Schemas exist for farm-events only; sensor, alert, billing, hr, messaging, tenant, auth, ai, notification events are unvalidated on ingest. |
| Outbox entity (`extends OutboxEntityBase`) | 3 services: farm (`farm_outbox`), hr (`hr_outbox`), messaging (`messaging_outbox`) | MODERN | `apps/farm-service/src/outbox/farm-outbox.entity.ts` | 12 other services still use direct `eventBus.publish` / `NatsEventBus` in handlers. See Table 3, row 2. |
| Direct `natsClient.publish` / `jsm.publish` / `NatsConnection.publish` outside outbox wrapper | **0 raw calls** in production. The 18 files matched in earlier sweep were TCP/WebSocket adapter `mqttClient`/`wsClient`/`nats.request` patterns — NOT backbone event publishing | COMPLIANT | — | The `NatsEventBus` (`platform/libs/event-bus`) is the only sanctioned backbone publisher. |
| `@CommandHandler / @QueryHandler / @EventsHandler` decorators | ~265 handler-file occurrences | MODERN — @nestjs/cqrs 11.0.3 | `apps/messaging-service/src/message/commands/send-message.handler.ts` | None. |
| `@Saga(...)` decorators | **0** | N/A | — | No sagas anywhere. Long-running workflows currently live inside event handlers. OK for current complexity; revisit when cross-aggregate compensations land (see Table 3, row 4). |
| Per-service `data-source.ts` (TypeORM CLI entry) | 7/15 services: ai, alert, billing, config, hr, messaging, notification | PARTIAL | `apps/ai-service/src/database/data-source.ts` | Farm/sensor/auth/admin-api/event-store/hydroponics/gateway have none. CLI commands (`typeorm migration:generate`) fail for those 7. See DATA-MEDIUM-005. |
| `migrationsRun: false` (runner owns execution) | All 12 app modules register `migrationsRun: false`; observability-service declares `migrations: []` (no migrations) | MODERN | `apps/ai-service/src/app.module.ts` | None. Canonical pattern. |
| Schema-per-tenant provisioning (`SchemaManagerService`, `SourceSchemaBootstrapService`, `TenantSchemaSyncService`) | 1 library (backend-common) used by 6 tenant-aware services (farm, sensor, hr, hydroponics, alert, ai, messaging — per MODULE_SCHEMAS) | MODERN | `libs/backend-common/src/database/schema-manager.service.ts` | None. |

---

## Table 2 — Anti-pattern Spots (slice-specific)

| Pattern | Count | Example (file:line) | Severity | Fix direction |
|---|---|---|---|---|
| `@Entity('name')` without `schema:` option (ADR-011 violation, SchemaDriftValidator blind spot) | 180 files / 209 declarations | `apps/event-store-service/src/event-store/entities/stored-event.entity.ts:14`, `apps/auth-service/src/modules/authentication/entities/user.entity.ts:50`, `apps/ai-service/src/conversation/conversation.entity.ts:10`, `apps/hr-service/src/hr/entities/hr-outbox.entity.ts:19`, `apps/farm-service/src/farm/entities/farm.entity.ts:~` | HIGH | Add `{ schema: '<service>' }` to every decorator. `createServiceTypeOrmConfig` currently compensates at runtime but drift-validator cannot reflect the declaration → false negatives. |
| Inline event-object literals (banned — branded `EventId` enforces compile error in prod) | 0 in production; 13 test fixtures | `tests/e2e/v11-upgrade/nats-crossversion.e2e-spec.ts:151` | LOW | Wrap the cross-version replay fixtures in a `mkFixtureEvent<T extends BaseEvent>()` helper that casts via `as EventId` once. Keeps the branded-type safety net intact and centralises the cast. |
| Raw `manager.getRepository(Entity)` inside transactional callbacks | ~151 of 155 occurrences (mostly legitimate) | `apps/auth-service/src/modules/authentication/services/authentication.service.ts:575`, `apps/farm-service/src/chemical/handlers/create-chemical.handler.ts:65` | MEDIUM | Legitimate inside `dataSource.transaction(manager => ...)`. But the `no-direct-get-repository` ESLint rule matches lexically on any `getRepository(` — tighten to detect whether the receiver is `queryRunner.manager` / transactional `manager` and allow only those. 4 non-transactional leaks remain (see DATA-HIGH-002). |
| `this.dataSource.getRepository(Entity).save(...)` (non-transactional, not `ScopedRepository`) | 4 confirmed | `libs/backend-common/src/audit/audited-operation.interceptor.ts:250`, `apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts:30`, `apps/config-service/src/configuration/handlers/update-configuration.handler.ts:38` | HIGH | Replace with `getScopedRepository(Entity)` inside a tenant-scoped wrapper. Config-service is tenant-neutral (schema `config`) but still needs scoping for audit/writer traceability. |
| `@Column({ type: 'jsonb' })` — typeable data dumped to jsonb | ~50 declarations across all services | `apps/alert-engine/src/database/entities/escalation-policy.entity.ts:159` (`severity`, `levels`, `on_call_schedule`), `apps/ai-service/src/tenant-config/agent-config.entity.ts:25` (`tools`, `personality`) | MEDIUM | Many of these are structurally typed (enum arrays, discriminated unions). Introduce dedicated typed columns or at minimum `transformer:` + Zod schema + `@Check` constraint so the DB refuses malformed JSONB. Per CLAUDE.md code-quality rule: `jsonb as any dumping ground` banned. |
| Migrations without reversible `down()` | ~15 of 64 migrations have no-op / logger-warn `down` (intentional for data consolidation) | `apps/messaging-service/src/migrations/1782500000000-ConsolidateTenantSchemaData.ts:176` ("no-op, data reversal requires restore"), `apps/messaging-service/src/migrations/1781600000000-AddCompositeFkIndexesOnMessageChildren.ts:228` | LOW (informational) | These are deliberate — data consolidation or index optimisation where reversal requires pg_dump restore. Acceptable IF documented in the migration docblock. Most comply. Flag any new destructive migration that ships without the documented rollback path in the commit body. |
| `ALTER TABLE ... SET search_path` **session-scoped** inside a migration | 2 files confirmed using `SET search_path TO ...` at migration body top (without `SET LOCAL`) | `apps/messaging-service/src/migrations/1782300000000-AddTenantIdToMessageChildren.ts:197`, `apps/messaging-service/src/migrations/1782400000000-EnableRowLevelSecurity.ts:102` | HIGH | Replace with `SET LOCAL search_path` INSIDE a `BEGIN; ... COMMIT;` block per the 2026-04-07 pool-contamination lesson. The migration runner's `QueryRunner` binds to one physical connection, but once returned to the pool, the session-scoped `SET` leaks. |
| `synchronize: true` in test fixtures | 2 test files + 1 documented exception (observability-service dev-only) | `apps/farm-service/src/batch/__tests__/integration/batch-lifecycle.integration.spec.ts:72`, `apps/farm-service/src/batch/__tests__/integration/tank-operations.integration.spec.ts:60` | LOW (tests only) | Acceptable for integration tests. observability-service exception documented in its app.module.ts and reads `DATABASE_SYNC` env — verify prod deploy hard-pins this to `false`. |
| `natsClient.publish` / `natsConnection.publish` raw call outside `NatsEventBus` / `OutboxPublisher` | **0 confirmed in production** | — | OK | No violation. Earlier 18-file hit was non-backbone (MQTT, WebSocket, `nats.request`). |
| Migration file mixing DDL + `CREATE INDEX CONCURRENTLY` in same transaction | Not searched exhaustively; spot check clean | — | LOW (spot-check only) | Recommend a lint pass (future) — `CREATE INDEX CONCURRENTLY` cannot live in a transaction block; breaks if co-located with `ALTER TABLE`. |
| Entity has `schema: 'public'` explicit | **0** | — | OK | No explicit public-schema entities. CLAUDE.md rule respected. |

---

## Table 3 — Modernization Opportunities (prioritized)

1. **Complete ADR-011 decorator-level schema attribution (180 entity files).** Highest-leverage single change: every `@Entity('x')` becomes `@Entity('x', { schema: '<service>' })`. Restores the `SchemaDriftValidator` to full deterministic coverage and removes the "runtime-factory inject compensates" silent dependency. Mechanical migration, high-ROI. Tracked as DATA-HIGH-001.

2. **Extend the transactional outbox from 3 to all 12 database-owning services.** Currently only farm/hr/messaging have outbox tables. The other 9 either (a) emit via `NatsEventBus.publish` directly (at-most-once if the tx rolls back after publish), or (b) emit before `queryRunner.commitTransaction` runs. `OutboxEntityBase` is reusable — one entity subclass + one migration per service. Tracked as DATA-HIGH-004. Very high reliability uplift.

3. **Adopt the `satisfies` operator for event-type narrowing in handler return paths (8+ handler files).** TS 4.9+ `satisfies` preserves the literal type while enforcing the interface contract. Example target: `return { ...createBaseEvent('SensorCalibrated', tenantId), sensorId } satisfies SensorCalibratedEvent;` — gives `.eventType` narrow-literal autocomplete downstream in subscribers. Currently the `createBaseEvent()` return type is widened by the `& Partial<BaseEvent>` intersection.

4. **JSON Schema validators for 8 remaining event domains.** `validateFarmEvent` exists; sensor-events, alert-events, billing-events, hr-events, messaging-events, tenant-events, ai-events, notification-events ship without validators. NATS subject-level validation at trust boundary is the canonical belt-and-suspenders against malformed events from older producers replaying old shapes (the upcaster catches structural change; the JSON Schema catches type violation).

5. **Converge the last 4 services onto `createMigrationRunnerService('<schema>')`.** sensor-service, admin-api-service, auth-service, event-store-service each run migrations via bespoke wiring. The factory enforces: `search_path` re-assertion, `DATABASE_MIGRATIONS_RUN=false` hard-fail, advisory-lock-per-schema guard. Inconsistent invocation = inconsistent guarantees. The `apps/db-migrate/` orchestrator is the eventual target.

6. **Ship a `mkFixtureEvent<T extends BaseEvent>()` test helper** in `@platform/testing` to centralise the 13 `as EventId` casts in cross-version e2e fixtures. Keeps branded-type safety intact, avoids drift in fixture shape.

7. **Add `data-source.ts` for the 7 services that lack one** (farm, sensor, auth, admin-api, event-store, hydroponics, gateway-api). Without it, `typeorm migration:generate` CLI is unavailable — developers either hand-write migrations (drift risk) or generate from a sibling service's data-source (wrong schema). Low effort, high dev-experience uplift.

8. **Consider `@Saga` adoption** once cross-aggregate compensations become real (e.g., tenant-offboarding across 8 schemas, batch-transfer-with-rollback). `@nestjs/cqrs` 11 supports sagas natively; current code uses event handlers with `EventEmitter2` as a light saga surrogate.

---

## Findings (domain-level)

### DATA-HIGH-001 — 180 `@Entity()` declarations lack explicit `schema:` option (ADR-011 violation)
- **Evidence:** 209 total bare `@Entity('<name>')` declarations across 180 files; only 28 declarations use `{ schema: '<svc>' }`. Examples: `apps/event-store-service/src/event-store/entities/stored-event.entity.ts:14`, `apps/auth-service/src/modules/authentication/entities/user.entity.ts:50`, `apps/ai-service/src/conversation/conversation.entity.ts:10`, `apps/hr-service/src/hr/entities/hr-outbox.entity.ts:19`, `apps/farm-service/src/outbox/farm-outbox.entity.ts:19` (decorator uses `{ name, synchronize: false }` but NOT `schema`).
- **Rule/ADR violated:** ADR-011 Schema Ownership Model (CLAUDE.md "Every `@Entity()` MUST declare `schema:`"); ADR-012 Schema Drift Prevention (SchemaDriftValidator inspects decorator metadata, not runtime-injected schema).
- **Fix direction:** Mechanical update — add `{ schema: '<service>' }` to each decorator. One pass per service (12 services). A follow-up ESLint AST rule should forbid `@Entity(stringLiteral)` without the object form. Runtime behaviour unchanged; what changes is that `SchemaDriftValidator` and generated migrations gain deterministic ground truth.

### DATA-HIGH-002 — 4 non-transactional `dataSource.getRepository(Entity).save(...)` leaks
- **Evidence:** `libs/backend-common/src/audit/audited-operation.interceptor.ts:250` (audit-log write), `apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts:30` + `:82`, `apps/config-service/src/configuration/handlers/update-configuration.handler.ts:38` + `:39`, `apps/config-service/src/configuration/handlers/delete-configuration.handler.ts:33`. All bypass `getScopedRepository()` and therefore the tenant-aware filter.
- **Rule/ADR violated:** CLAUDE.md "getRepository() is FORBIDDEN → use getScopedRepository()"; tenant isolation defense.
- **Fix direction:** Config-service is tenant-neutral (schema `config`) but still carries `tenantId` on `configurations` — promote to `ScopedRepository`. The audit interceptor write path must establish tenant context from `AsyncLocalStorage` or the interceptor's request context, not the raw dataSource.

### DATA-HIGH-003 — Session-scoped `SET search_path` inside migration bodies (pool-contamination regression risk)
- **Evidence:** `apps/messaging-service/src/migrations/1782300000000-AddTenantIdToMessageChildren.ts:197`, `apps/messaging-service/src/migrations/1782400000000-EnableRowLevelSecurity.ts:102` — both use `SET search_path TO "messaging", public` (session-scoped), not `SET LOCAL`.
- **Rule/ADR violated:** Data-expert prompt section "Database Connection Isolation" (2026-04-07 pool-contamination lesson). `MigrationRunnerService` binds to one `QueryRunner`/connection — but once the migration completes and the connection returns to the pool, the `search_path` persists for whoever checks it out next.
- **Fix direction:** Wrap in `BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'; SET LOCAL search_path = 'messaging', public; ...DDL...; COMMIT;`. `SET LOCAL` releases at COMMIT/ROLLBACK and cannot leak.

### DATA-HIGH-004 — Transactional outbox coverage at 3/12 services (silent at-most-once risk on 9 services)
- **Evidence:** Outbox entities found only at `apps/farm-service/src/outbox/farm-outbox.entity.ts`, `apps/hr-service/src/hr/entities/hr-outbox.entity.ts`, `apps/messaging-service/src/outbox/messaging-outbox.entity.ts`. The other 9 services (auth, billing, sensor, alert, ai, admin-api, config, notification, hydroponics) publish via `NatsEventBus.publish` directly from command handlers.
- **Rule/ADR violated:** CLAUDE.md event-driven contract (events must be at-least-once and transactionally consistent with the write that triggered them). Dropping the event when the transaction commits but the publish hop fails is a class of undetected data drift.
- **Fix direction:** Per service, add a concrete `OutboxEntityBase` subclass + migration + `OutboxModule.forFeature(XOutbox)`. `OutboxWorkerService` in `platform/libs/outbox` already handles polling, publishing, lease + retry.

### DATA-MEDIUM-004 — JSON Schema event validation covers only the farm domain (8 domains unvalidated)
- **Evidence:** `libs/event-contracts/src/schemas/` contains `farm-events.schema.ts` + `validator.ts`. No `sensor-events.schema.ts`, `alert-events.schema.ts`, `billing-events.schema.ts`, `hr-events.schema.ts`, `messaging-events.schema.ts`, `tenant-events.schema.ts`, `ai-events.schema.ts`, `notification-events.schema.ts`.
- **Rule/ADR violated:** ADR-006 Event Contract flat pattern — upcasters handle structural evolution; JSON Schema handles the trust-boundary validation layer. Current coverage 1/9.
- **Fix direction:** Generate schemas from the TS interfaces via `ts-json-schema-generator` (one-time codegen step), wire each domain's validator into the corresponding NATS consumer. Reject-or-quarantine malformed inbound events at subscription layer before they reach handlers.

### DATA-MEDIUM-005 — 7/15 services have no `data-source.ts` CLI entry
- **Evidence:** `data-source.ts` exists for ai, alert, billing, config, hr, messaging, notification; absent for farm, sensor, auth, admin-api, event-store, hydroponics, gateway-api.
- **Rule/ADR violated:** ADR-012 Migration Runner consistency ("Each service has `apps/<svc>/src/database/data-source.ts` (TypeORM CLI entry point)").
- **Fix direction:** Add the file per service with the canonical template — schema, entities glob, migrations glob, `synchronize: false`, `migrationsRun: false`, `logging` env-gated.

### DATA-MEDIUM-006 — ~50 `@Column({ type: 'jsonb' })` columns that could be typed or constraint-checked
- **Evidence:** `apps/alert-engine/src/database/entities/escalation-policy.entity.ts:159-207` (6 jsonb columns including `severity`, `levels`, `on_call_schedule`, `suppression_windows`, `rule_ids`, `farm_ids` — last two are ID arrays, NOT jsonb material); `apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts` (15 jsonb columns); `apps/admin-api-service/src/system-management/entities/` (~40 jsonb across the folder).
- **Rule/ADR violated:** CLAUDE.md "jsonb as 'dumping ground'" forbidden.
- **Fix direction:** Per column: (a) if it's an ID array → `text[]` or relation + join table; (b) if it's a structured union → typed DTO + Zod validator + `transformer` + `@Check` DB-level constraint; (c) if it's free-form telemetry → keep jsonb but narrow the TS type from `any` to the discriminated union.

### DATA-LOW-007 — 13 test-fixture inline event literals use `as EventId` casts
- **Evidence:** `tests/e2e/v11-upgrade/nats-crossversion.e2e-spec.ts:151,165,320,368,411,578,979,1017,1024,1100,1122,1244`, `apps/alert-engine/src/alert/event-handlers/__tests__/sensor-reading.handler.spec.ts:80+`.
- **Rule/ADR violated:** None strictly — branded `EventId` is a compile gate; tests legitimately bypass it. Style-level only.
- **Fix direction:** Add `mkFixtureEvent<T extends BaseEvent>()` helper in `@platform/testing` that performs the single cast centrally. Keeps test surface DRY and prevents skew when `BaseEvent` gains a new required field.

### DATA-LOW-008 — Zero `@Saga(...)` usage across the platform
- **Evidence:** grep `@Saga\(` returns 0 matches.
- **Rule/ADR violated:** None yet — noted as architectural opportunity.
- **Fix direction:** Not a defect at current complexity. Re-evaluate when cross-aggregate compensation patterns land (tenant offboarding, batch transfer reversal, subscription downgrade cascade). `@nestjs/cqrs` 11 sagas are rxjs-based and map well to those workflows.

---

## Appendix — Positive Observations (worth preserving in synthesis)

- **Branded `EventId` compile-time gate is working.** Zero inline event literals in production code despite 278 event construction sites. This is the "Tier 1 — Make it impossible" architectural pattern from CLAUDE.md actually in production.
- **Legacy TypeORM `Connection` API is fully eradicated in backend.** Only hit is in a frontend store (not a TypeORM `Connection` — different symbol).
- **`SchemaDriftModule.forRoot` coverage: 12/12.** Every database-owning service wires the drift validator.
- **`synchronize: false` discipline holds in production.** The 2 integration-test `synchronize: true` usages are bounded; observability-service's dev-only `DATABASE_SYNC` env flag is explicitly documented and gated.
- **Upcaster infrastructure is in place and exercised** — 3 concrete upcasters + 4 timestamp-bump wrappers registered in `createDefaultRegistry()`. The registry is the canonical read-side decoder for stream replay.
- **No raw NATS publish calls on the event backbone.** All domain event publishing flows through `NatsEventBus` or the 3 outbox workers.
- **Per-service `createMigrationRunnerService` adoption is 8/15 and consistent where used.** The factory enforces the `search_path` re-assertion contract per the 2026-04-07 lesson.
