# Orphan Findings — Plan-Independent Real Problems

**Purpose:** Problems spotted while reading code for planned work (ADRs / Faz implementation) that are **NOT** part of the current plan. Discovery → test → document here.

**Policy:** Append-only. Findings RESOLVED via commits carry closure note + commit SHA. Never silently dropped.

**ID format:** `ORPHAN-{NNN}`

**Related memory:** `feedback_orphan_findings_doc.md`

---


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

**ID format:** `ORPHAN-{NNN}`

**Related memory:** `feedback_orphan_findings_doc.md`

---


## ORPHAN-001 — `opentelemetry` 0.27 vs `tracing-opentelemetry` 0.28 version family drift

**Severity:** MEDIUM
**Discovered:** 2026-04-19, Batch 1 Cargo.toml audit (edge-expert)
**File:** `/tmp/edge-work/sens-api-gateway/Cargo.toml` lines 150-153

**Evidence:**
```toml
opentelemetry = { version = "0.27", optional = true }
opentelemetry-otlp = { version = "0.27", features = ["trace"], optional = true }
opentelemetry_sdk = { version = "0.27", features = ["rt-tokio"], optional = true }
tracing-opentelemetry = { version = "0.28", optional = true }
```

**Problem:** `tracing-opentelemetry` 0.28 requires `opentelemetry` 0.27 (compatible major line), which aligns at compile time, but the `tracing-opentelemetry` 0.28 → 0.29 upgrade pulls `opentelemetry` 0.28+; any future bump to one crate alone will break. These four crates form a **coupled release family** and should be pinned together with explicit compatibility note.

**Risk:** Silent `cargo update` or dependabot PR upgrading only one crate → compile fail with cryptic type-mismatch errors across `tracing-opentelemetry` ↔ `opentelemetry_sdk` boundary.

**Reproducibility:**
1. `cargo update -p tracing-opentelemetry --precise 0.29`
2. `cargo check --features telemetry`
3. Expect: opaque type-level error in `tracing-opentelemetry::OpenTelemetryLayer` construction.

**Recommendation:**
- Add grouped comment block: *"OpenTelemetry coupled-release family — bump all four crates atomically OR none."*
- Consider dependabot group rule grouping these four crates.
- Or switch to `opentelemetry-all-in-one` crate (if exists) that locks the version family.

**Status:** OPEN (documented; no fix in Batch 1 scope — Faz 0 only touches new deps).

---


## ORPHAN-002 — `rodbus = "=1.4.0"` empty-Path workaround depends on un-specified behavior

**Severity:** HIGH (pre-existing; code comment BUG-005 acknowledges)
**Discovered:** 2026-04-19, Batch 1 Cargo.toml review
**File:** `/tmp/edge-work/sens-api-gateway/Cargo.toml` lines 60-70 + `sens-api-gateway/src/modbus.rs` (referenced)

**Evidence (existing comment in Cargo.toml):**
```
# BUG-005 (version pin): The server-only TLS path in modbus.rs passes empty
# Path::new("") for the client cert/key arguments to TlsClientConfig::full_pki().
# This relies on rodbus 1.4 treating an empty OsStr path as "no client certificate".
# If rodbus changes this behavior in a future minor version, Modbus TLS connections
# without client certs will silently fail or panic.
# Do NOT bump this dependency without re-testing server-only TLS (no mTLS) connections.
```

**Problem:** `Path::new("")` empty-path workaround for "no client cert" in `TlsClientConfig::full_pki()` is not a documented API contract. Future rodbus patch version (even 1.4.x patch bump) could change this to validate Path non-empty → silent Modbus TLS failure in production.

**Risk:**
- Production Modbus TLS silently fails post-dependency update
- SL-2 FR1 identification broken (mTLS required per deployment)
- Pre-existing tech debt, tracked by BUG-005 but no architectural fix

**Reproducibility:**
1. Bump rodbus patch version to next minor (if available).
2. `cargo check` + `cargo test --test modbus_tls_server_only`
3. Expect: potential Path validation failure OR silent cert-skip in rodbus internals.

**Recommendation:**
- Plan §5 Faz 1 ARC-007 **already tracks this**: `rodbus = "~1.4.0"` (patch-level) + `enum TlsMode { Full{cert,key}, ServerOnly, None }`. Empty-path hack removed via explicit enum in modbus.rs refactor.
- This orphan-finding confirms Faz 1 ARC-007 scope; architectural fix in Faz 1 Sprint 1.8.

**Status:** OPEN → tracked by plan ARC-007 → Faz 1 Sprint 1.8 resolves (TlsMode enum).

---


## ORPHAN-003 — `nix` feature `process` may pull unused capability wrappers; capability drop likely goes through `libc` direct FFI

**Severity:** LOW
**Discovered:** 2026-04-19, Batch 1 audit (edge-expert BATCH-001-FINDING-006)
**File:** `/tmp/edge-work/sens-api-gateway/Cargo.toml` line 209

**Evidence:**
```toml
nix = { version = "0.29", features = ["fs", "process", "signal", "user"] }
```

**Problem:** `nix 0.29` capability wrappers (`prctl`, `capset`) are incomplete vs what ADR-019 §5 + ADR-020 §3a need. Expected implementation path:
- `CAP_LINUX_IMMUTABLE` drop → likely via `libc::prctl(PR_CAPBSET_DROP, ...)` direct FFI (libc already imported line 196)
- `fcntl(F_SETLK)` advisory lock → `nix::fcntl` covered
- Signal handling → `nix::sys::signal` covered
- User/group manipulation → `nix::unistd` (feature `user`) covered

**Risk:** If `nix::process` feature unused in actual implementation, dead dep tree weight.

**Reproducibility:** After Faz 2 Sprint 6.3 `src/keystore/hardening.rs` lands, `cargo tree -e features -p nix` will show unused symbols. Benchmark binary size with/without feature.

**Recommendation:**
- During Faz 2 Sprint 6.3 implementation: evaluate whether `libc` direct FFI replaces all `nix::process` needs.
- If yes: drop `process` feature; comment update: *"Capability drop via libc::prctl direct FFI; nix::process feature not used."*
- If no: keep feature; add concrete usage comment.

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
