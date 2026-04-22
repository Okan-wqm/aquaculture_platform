# Orphan Findings

Plan-independent real problems uncovered while reading code. See memory
`feedback_orphan_findings_doc.md` for the policy.

## DEPLOY-CRITICAL-005 — MigrationAuditModule missing EventBusModule.forRoot() import (2026-04-21)

**Status:** RESOLVED — fixed by the commit that introduces this entry.

**Scope:** `apps/observability-service/src/migration-audit/migration-audit.module.ts`

**Symptom (deploy, 2026-04-21 14:03 UTC):**

```
observability-service — container=aqua-observability health=starting state=restarting
...
--- Round 30/30: 1 signal(s) pending ---
Error: Missing boot signals:
  [observability-service] "Schema drift scan clean" — SchemaDriftValidator found zero violations (ADR-012)
```

aqua-db-migrate completed successfully, other services booted green,
but observability-service entered an infinite restart loop. The deploy
asserter timed out after 30 × 10s rounds waiting for the "Schema drift
scan clean" boot signal that the container never reached.

**Root cause:**

Phase 6 Step 6 added `SchemaMigrationEventsConsumer` as a provider
in `MigrationAuditModule` with `NatsEventBus` constructor injection.
`NatsEventBus` is registered by `EventBusModule.forRoot()` — NOT a
global provider. Modules that consume `NatsEventBus` MUST import
`EventBusModule.forRoot()` in their own `imports` list. The pattern
is already used by `SecurityEventsModule` in the same service.
`MigrationAuditModule` registered the consumer without the import.
Nest's DI container threw before any module lifecycle ran:

```
Nest can't resolve dependencies of the SchemaMigrationEventsConsumer
(?, CommandBus). Please make sure that the argument NatsEventBus at
index [0] is available in the MigrationAuditModule context.
```

Container crash → Docker restart → Nest DI fails again → infinite
restart → `SchemaDriftValidator` never runs → required boot signal
never emitted → deploy asserter times out → rollback.

**Fix:**

Added `EventBusModule.forRoot()` to `MigrationAuditModule.imports`.
Mirrors the pattern established by `SecurityEventsModule`. Architectural
invariant documented in the module docblock: every module registering a
`NatsEventBus`-consuming provider MUST import `EventBusModule.forRoot()`.

**Why this is the correct final fix, not a patch:**

The gap was a missing module boundary contract. The fix restores the
contract (module owns its DI graph fully) without introducing a
workaround (e.g. making NatsEventBus global, which would pollute
unrelated modules' DI scope). Future authors who add NATS consumers
to a module now have both a precedent (SecurityEventsModule) and a
docblock reminder.

**Verification:**

- All 55 observability-service tests still pass (DI fix is additive).
- SchemaMigrationEventsConsumer.subscribeTo NATS failure path was
  already swallowing errors in onModuleInit — container won't
  crash-loop even if NATS is down at boot.
- Next deploy should show observability reaching
  SchemaDriftValidator.onApplicationBootstrap within round 1-5
  and emitting "Schema drift scan clean".

## TEST-PREEXISTING-002 — pre-existing TS errors in leader-election + watchdog specs (2026-04-21)

**Status**: OPEN. Unrelated to the db-migrate enterprise refactor;
surfaced during a Phase 6 Step 2 type-check sweep.

**Scope**:
- `libs/backend-common/src/orchestrator-leader-election/leader-election.service.spec.ts`
- `libs/backend-common/src/database/__tests__/watchdog.integration.spec.ts`

**Symptoms (tsc errors under tsconfig.spec.json)**:

```
leader-election.service.spec.ts(46,9): error TS2416:
  Property 'set' in type 'FakeRedis' is not assignable to the same property
  in base type 'RedisLike'. Types of parameters 'args' and 'callback' are
  incompatible.
leader-election.service.spec.ts(79,9): error TS2416:
  Property 'eval' in type 'FakeRedis' is not assignable ...
  Target signature provides too few arguments. Expected 4 or more, but got 3.
watchdog.integration.spec.ts(145,17): error TS2322:
  Type 'Date' is not assignable to type 'string'.
```

Root cause: `ioredis` updated its type signatures for `set()` + `eval()`
(variadic + callback overloads added); the `FakeRedis` test double in
leader-election.service.spec.ts does not match the new shape. Similarly
the watchdog spec passes a Date where the current `RedisKey` type
expects a string.

**Why surfaced now**: Phase 6 Step 2 tightened the migration-runner
factory's type signature (added optional `eventSink`). The downstream
tsc run over tsconfig.spec.json reported these pre-existing errors
alongside the ones I fixed (three specs had colliding top-level
`main` const names).

**Next step**: owner audit for `orchestrator-leader-election` module.
Likely fix: update FakeRedis.set signature to accept
`Callback<"OK"> | string | number` in the variadic tail, OR switch to
`jest-mock-redis` upstream lib. NOT blocking the v3 refactor — the
runtime code doesn't fail; tsc errors are test-shim only.

## TEST-PREEXISTING-001 — schema-manager.spec.ts: 3 tests fail regardless of current branch changes (2026-04-21)

**Status**: OPEN. Documented during Phase 2 implementation; not caused by
any v3 refactor commit.

**Scope**: `libs/backend-common/src/database/__tests__/schema-manager.spec.ts`

**Symptoms**:
- `should drop schema on failure (rollback)` — fails with "Schema creation failed"
- `should reset search_path to public using set_config` — fails
- `should handle migration errors gracefully` — fails

Reproducible on baseline (git stash of unrelated changes → same 3 fail).
Last commit to touch the spec was `734fd574` (L3 audit remediation) —
predates the db-migrate enterprise refactor.

**Why surfaced now**: the Phase 2 severity-aware validator refactor
triggered a broader `nx affected --target=test` run which included
schema-manager tests. They would have failed identically on main
before Phase 1 kick-off.

**Next step**: owner audit — likely a test-fixture mismatch with
schema-manager.service.ts behaviour (mock expectations drifted vs
real service). NOT blocking the v3 refactor; tracked here so future
reviewers know it's not a v3-introduced regression.

## DEPLOY-CRITICAL-004 — nullability + uuid drift survives first-phase HR heal, blocks SchemaDriftValidator clean signal

**Status:** RESOLVED — fixed by the commit that introduced this entry.

**Scope:** `apps/hr-service/src/database/migrations/1787000000000-HealHrNullabilityDrift.ts`
plus every tenant clone created from the `hr` source schema.

**Symptom (deploy 11 on d943f605, 2026-04-21 04:17 UTC):**

```
##[error]Missing boot signals:
  [hr-service] "Schema drift scan clean" — SchemaDriftValidator found zero violations (ADR-012)
--- Round 30/30: 1 signal(s) pending ---
```

HealHrEnumTypeDrift1786900000000 ran clean (65 heal queries applied on
source hr + 5 tenant clones, DROPped IDX_emp_cert_expiry + leave_no_overlap),
db-migrate exit 0, every container healthy, service-criticality check
green. But the hr-service boot-signal asserter timed out after 30 × 10 s
rounds — signal name only revealed at round 30, confirming HR was still
the blocker.

**Root cause** (confirmed by three parallel code reads of
`libs/backend-common/src/database/schema-drift-validator.service.ts`,
`scripts/deploy/assert-service-signals.ts`, and every service's signal
emit-site):

SchemaDriftValidator checks three drift classes (lines 195–252):

  1. Schema location (entity schema=hr, DB table in hr)
  2. UUID-type mismatch: `entity.type === 'uuid' && dbColumn.data_type !== 'uuid'` (line 237)
  3. Nullability mismatch: `!column.isNullable && dbColumn.is_nullable === 'YES'` (line 247)

HealHrEnumTypeDrift's whitelist kept CREATE TYPE / CREATE TABLE /
ADD COLUMN IF NOT EXISTS / ALTER COLUMN <any sub-action>. Two gaps:

- `ADD COLUMN IF NOT EXISTS "x" type NOT NULL DEFAULT ...` is a no-op
  when the column already exists — the pre-existing nullable column's
  nullability is NEVER updated. TypeORM `log()` does not reliably
  emit a standalone `ALTER COLUMN SET NOT NULL` for this diff class;
  the debug dump from d943f605 confirmed no SET NOT NULL statements
  in the 65 applied queries.
- UUID-type mismatch for pre-existing columns is emitted by log()
  only under specific conditions TypeORM's schema-builder uses; not
  guaranteed to cover every case.

`SCHEMA_DRIFT_FATAL=false` (default) means drift logs `error()` but
continues boot — container stays healthy, but the "clean" signal
string never emits, so the asserter times out.

**Fix** (Tier-1 entity-metadata iteration, not a log()-diff whitelist):

1. `apps/hr-service/src/database/migrations/1787000000000-HealHrNullabilityDrift.ts`
   iterates `conn.entityMetadatas` filtered to `schema === 'hr'` and for
   every column compares `information_schema.columns` to the entity
   declaration. Emits exactly the two statements the validator contract
   requires when drift is present:
   - `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${col}" SET NOT NULL`
   - `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${col}" TYPE uuid USING "${col}"::text::uuid`

2. Empty-table precondition preserved (SET NOT NULL / TYPE uuid fail on
   dirty rows). Non-empty tables raise — operator must hand-author
   data-preserving ALTERs for those.

3. Per-tenant fan-out with identical guard + iteration.

4. `down()` no-op: rolling back would re-introduce the drift and break
   hr-service boot.

**Why this is the correct final fix for HR drift:**

SchemaDriftValidator checks EXACTLY three drift classes. Class (1) was
covered by first-phase heal. This migration explicitly covers classes
(2) and (3) by direct entity-metadata iteration — no dependence on
whether TypeORM `log()` happens to emit the right DDL for pre-existing
columns. Post-migration, `violations.length === 0` → validator emits
"Schema drift scan clean" → asserter substring-match succeeds within
round 1–5 → deploy green.

**Verification:** The CI-Affected → deploy run on this commit will
show `aqua-db-migrate` applying `HealHrNullabilityDrift1787000000000`
(pending count = 1 under hr schema), the per-schema log lines reporting
`[hr] validator-contract heal: N SET NOT NULL, M TYPE uuid, ...`, and
the boot-signal assertion passing within one round of the 30-round
window.

## DEPLOY-CRITICAL-003 — partial-index WHERE predicate blocks ALTER COLUMN TYPE

**Status:** RESOLVED — fixed by the commit that introduced this entry.

**Scope:** `apps/hr-service/src/database/migrations/1786800000000-SyncHrEntitiesToDb.ts`
plus every tenant clone created from the `hr` source schema.

**Symptom (deploy 7, 2026-04-20 18:11 UTC):**

```
aqua-db-migrate | Migration failed — schema: hr, migration: SyncHrEntitiesToDb1786800000000
  error: operator does not exist: employee_certifications_status_enum = certification_status
```

Deploy 8 (2026-04-20 18:32 UTC) introduced commit `5df00179` which wrapped
every `log()`-emitted statement in `SAVEPOINT / ROLLBACK TO SAVEPOINT` so
the failing `ALTER COLUMN TYPE` was silently skipped and the migration
exited 0. That shifted the failure downstream: SchemaDriftValidator at
hr-service boot observed the old enum column, never emitted the
`Schema drift scan clean` required-signals invariant, the boot-signal
assertion timed out after 30 rounds (7.5 min), and the deploy rolled
back.

**Root cause:** `hr.employee_certifications` carries a legacy partial
index whose WHERE predicate casts a literal to the column's OLD enum
type:

```sql
CREATE INDEX "IDX_emp_cert_expiry"
  ON "hr"."employee_certifications" ("tenant_id", "expiry_date")
  WHERE (status = 'active'::hr.certification_status);
```

When `ALTER COLUMN status TYPE hr.employee_certifications_status_enum`
runs, PostgreSQL re-validates the predicate against the new enum. PG
has no implicit equality operator between two distinct enum types, so
the ALTER aborts. `RdbmsSchemaBuilder.log()` cannot emit a preceding
`DROP INDEX` because the index was created outside the current entity
model (legacy, hand-authored DDL).

**Fix (Tier-1 "make it impossible"):**

1. `libs/backend-common/src/database/base-migration.ts` —
   `parseAlterColumnTypeTargets()` + `dropDependentPartialIndexes()`.
   Parses the up-queries that `log()` emits, queries `pg_indexes` for
   partial indexes whose WHERE predicate references any of the target
   columns, and DROPs them explicitly.
2. `apps/hr-service/src/database/migrations/1786800000000-SyncHrEntitiesToDb.ts`
   calls the helper BEFORE the apply loop (source hr + every tenant
   clone) and removes the SAVEPOINT-per-statement band-aid. The apply
   loop is deterministic again: any failure escapes to the
   orchestrator and rolls back the migration transaction.
3. Legacy indexes the current entity model does not declare stay
   dropped — correct end-state under ADR-012's entity-first schema
   contract. Indexes the entity DOES declare are re-created by
   TypeORM's own `CREATE INDEX` emissions in the same migration pass.

**Unit test:** `libs/backend-common/src/database/__tests__/base-migration.spec.ts`
covers: (a) parse extracts only TYPE changes, not SET NOT NULL /
DEFAULT adjustments; (b) drop matches only partial indexes whose
predicate references the target column by whole-word; (c) substring
collisions (`status` vs `status_extended`) do not false-positive;
(d) unsafe identifiers throw.

**Verification:** GitHub Actions `CI - Affected → deploy / deploy`
pipeline on the commit that introduced this entry — aqua-db-migrate
logs `applied <N> validator-relevant catch-up queries` with no
SAVEPOINT rollback, HR boot emits `Schema drift scan clean`, deploy
completes green without rollback.

---

## RUST-MIG-HIGH-001 — TS mqtt-listener.service.ts still emits SensorReading V1 nested format (2026-04-22)

**Status:** OPEN — scope belongs to sensor-service refactor, outside Rust sidecar plan.

**Scope:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1413-1419`

**Symptom / evidence:**

```typescript
await this.eventBus.publish({
  ...createBaseEvent('SensorReading', sensor.tenantId, {...}),
  timestamp: timestamp.toISOString(),
  sensorId: sensor.id,
  readings: data,    // nested V1 field
  version: 1,
});
```

The TS cloud listener still emits `SensorReading` events in the V1 nested-`readings` format while `libs/event-contracts/src/sensor-events.ts:10-24` has already flipped to the V2 flat-field interface (`readingTemperature`, `readingPh`, etc.). The upcaster `libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts:25-46` papers over the drift at the consumer side, but the emitter is the point of truth and should speak V2 directly.

**Why it's orphan:**

Rust sensor-ingestion migration plan (`snappy-sniffing-pine.md` Kör Nokta 5) adds the `raw_value` field + V2 contract for the Rust sidecar only. Flipping the NestJS emitter is a sensor-service change and does not belong in the Rust sidecar PRs. The `phased rollout matrix` in the migration runbook keeps V1 emitters valid during Phase 0-2; this finding tracks the Phase-3 cut-over when TS must match.

**Proposed fix (not for this session):**

1. Update `mqtt-listener.service.ts` to build the `SensorReadingEvent` with flat V2 fields + `raw_value` from the edge payload.
2. Remove the call path into the V1→V2 upcaster (it becomes a read-only legacy translator).
3. Add regression: `mqtt_listener_publishes_sensor_reading_in_v2_flat_format.spec.ts`.
4. Dependencies: `raw_value` must exist in the sensor payload wire format — gated by ADR-026 (sensor-payload raw_value contract) acceptance.

**Blocked by:** ADR-026 merge + Phase-3 of `docs/runbooks/sensor-payload-v2-migration.md`.

---

## OBSERVE-HIGH-002 — Prometheus annotation-based scrape is an injection DoS risk (2026-04-22)

**Status:** OPEN — infrastructure-scope, pre-existing before Rust plan.

**Scope:** `infrastructure/monitoring/prometheus/prometheus-values.yaml:59-78`

**Symptom / evidence:**

The Helm values file declares `additionalScrapeConfigs` that relies on pod annotations (`prometheus.io/scrape: true`) to dynamically discover scrape targets. The same file carries an inline `SEC-NM-018` warning flagging the risk: "Annotation-based pod scraping is a security risk — any pod can inject itself." The risk is documented but the fix was deferred.

**Why it's orphan:**

The Rust plan (`snappy-sniffing-pine.md` Kör Nokta 4) prescribes a **static** scrape-config for `sensor-ingestion` and requires the annotation-based discovery to be disabled — the plan's fix for sensor-ingestion covers that one service. The broader migration (remove annotation-based discovery for ALL services, convert every service to a static job entry) is a platform-observability refactor, not sensor-ingestion scope.

**Proposed fix:**

1. Enumerate every service currently relying on `prometheus.io/scrape` annotations.
2. Add a static job entry per service in `infrastructure/monitoring/prometheus/scrape-configs.yml` (new central file).
3. Remove `additionalScrapeConfigs` from Helm values.
4. Add CI invariant `infrastructure-tests/prometheus-no-annotation-scrape.spec.ts` — fails if any pod spec carries `prometheus.io/scrape`.

**Related:** `docs/observability/metrics-cardinality-policy.md` (created by Kör Nokta 4 in the Rust plan).

---

## EDGE-SECURITY-001 — `sens-api-gateway` OTA firmware update protocol + signing is undocumented (2026-04-22)

**Status:** OPEN — edge-scope, parallel agent owns the gateway codebase.

**Scope:** `sens-api-gateway/` repository surface (no `.github/workflows/*release*.yml` or firmware-signing pipeline found).

**Symptom / evidence:**

The edge gateway is IEC 62443 SL2 hardened (`sens-api-gateway/deny.toml:1-111` enforces tight crate allowlist, TLS-only, OpenSSL banned). However, the **update channel** is silent:

- No cosign / sigstore signing of release artifacts.
- No documented firmware update protocol (how a running gateway on a customer tank replaces its binary).
- No anti-rollback mechanism to prevent downgrade attacks.
- No `release.yml` GitHub Actions workflow for binary builds with attestation.

**Why it's orphan:**

Rust plan Faz 4 mentions edge-adoption of shared crates but does not address the deployment/update channel. The Rust plan's Kör Nokta 9 (`snappy-sniffing-pine.md`) adds cosign/sigstore for the **cloud** sidecar; the edge gateway remains out of scope.

**Proposed fix (separate plan):**

1. ADR for firmware update protocol (signed manifest, two-slot A/B, rollback protection).
2. Release pipeline producing signed binaries + SBOM per target (armv7, aarch64).
3. Gateway runtime verifies signatures against rotated offline CA before accepting update.
4. Fleet management channel (MQTT topic or HTTPS pull) for update delivery + staged rollout.

**Scope dependency:** parallel agent (`agentic-rust-faz0` worktree) owns `sens-api-gateway/` — cross-team coordination required before any change.

---

## PLATFORM-HIGH-001 — `@platform/event-bus` lacks NATS request-reply API (2026-04-22)

**Status:** OPEN — the Rust migration plan depends on this API; the platform lib must provide it.

**Scope:** `platform/libs/event-bus/src/nats/nats-event-bus.ts` (pure pub-sub only).

**Symptom / evidence:**

The TS event-bus exposes `publish`, `subscribe`, `subscribeTo` but no `request` / `respond` primitive. Rust plan Kör Nokta 6 (`snappy-sniffing-pine.md`) requires `policy.ingest_backend.snapshot` request-reply for sidecar boot — the Rust side can use `async-nats::request()` directly, but the TS responder (hosted in `admin-api-service`) needs a symmetric abstraction.

**Why it's orphan:**

Adding request-reply to `@platform/event-bus` is a public-API extension that affects every backend service. It needs its own ADR (ADR-029 in the delta plan), CODEOWNERS review from the platform team, and migration guidance for existing services. The Rust sensor-ingestion PR depends on this landing first, but the platform-lib change is not sensor-ingestion scope.

**Proposed fix:**

1. Draft ADR-029 — NATS request-reply pattern adoption.
2. Extend `NatsEventBus` with `request<T,R>(subject, payload, timeoutMs): Promise<R>` and `respond(subject, handler: (req) => Promise<R>)`.
3. Backwards-compatible: existing pub-sub users unaffected; responders register via explicit `respond()` call.
4. Wire `admin-api-service` as the first responder (for `policy.ingest_backend.snapshot`) and `sensor-ingestion` as the first Rust requester (via async-nats).
5. Tests: timeout handling, error propagation, correlation-id pairing, mTLS cert-only identity preserved.

**Blocks:** Rust migration PR-B (`snappy-sniffing-pine.md` PR-B).

---

## MIGRATE-MEDIUM-001 — `apps/db-migrate` runner rollback workflow not verified (2026-04-22)

**Status:** OPEN — investigation pending; plan assumes bidirectional migrations but runner support unclear.

**Scope:** `apps/db-migrate/src/` (not read during Rust plan audit).

**Symptom / evidence:**

CLAUDE.md (ADR-011) mandates blue-green safe migrations: "nullable → backfill → NOT NULL". TypeORM migrations support `up()` + `down()`. The Rust plan's Kör Nokta 14 requires rollback migrations for V015 (chunk retune), V016 (outbox), V017 (RLS). However, whether the `apps/db-migrate` runner actually invokes `down()` on failure — or offers a CLI `run --down` subcommand — is not verified; the audit did not open the runner source.

**Why it's orphan:**

Verifying + (if needed) implementing the rollback path is runner-infrastructure scope. The Rust plan will write `down()` migrations, but if the runner cannot execute them in production, the rollback promise is hollow. This finding gates the "rollback works" claim in PR-A-safety + PR-B of the Rust plan.

**Proposed fix:**

1. Audit `apps/db-migrate/src/` — does `MigrationRunnerService` support `revertMigration()` / `run --down N`?
2. If missing: add the CLI subcommand + `apps/db-migrate` integration test that runs `up → down → up` round-trip.
3. CI rollback workflow: on deploy failure, trigger `apps/db-migrate run --down` against the failing migration.
4. Runbook `docs/runbooks/migration-rollback.md` — operator procedure.

**Related:** `docs/runbooks/sensor-ingestion-rollback.md` (to be created by Rust plan Kör Nokta 14) depends on this runner capability.
