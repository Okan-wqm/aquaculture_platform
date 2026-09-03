# Post-Merge CI Repair — Five Red Workflows on the PR #1330 Merge Tree

Date: 2026-08-28 · Agent: zcode · Branch: `feat/100-tenant-readiness-v3` (merge commit `f34c84d16`)

## Scope

The push of the main-merge commit turned five GitHub workflows red. This
review records each root cause and its fix (all verified locally before
push). No production code path changed behaviour except where noted.

## SENSOR-MEDIUM-101 — merged tree fails five CI workflows

### 1. GraphQL Codegen Up-To-Date + Apollo Supergraph Validate

`AlertHistory.sourceEventId` was declared `string | null`. The `| null`
union widens `reflect-metadata`'s `design:type` to `Object`, so the NestJS
SDL emit died with:

```
FATAL emitting subgraph SDL: Undefined type error. Make sure you are
providing an explicit type for the "sourceEventId" of the "AlertHistory" class.
```

Fix: narrow to `string` (nullable remains expressed by the
`@Column({ nullable: true })` / `@Field({ nullable: true })` options; no
caller ever assigns `null`). Local proof: `build-supergraph.mjs` composes
11 subgraphs, exit 0.

### 2. Rust CI

`policy.rs` (ADR-031 orchestrator) defined `spawn_policy_subscriber` and
friends, but the restored `main.rs` never called them — 12 dead-code
errors under `RUSTFLAGS=-D warnings`. Fix: wire the subscriber — hold a
concrete `Arc<DynamicBackendPolicy>`, spawn the NATS-gated change-stream
subscriber, call `source.emit_metric()`, cancel + join it before teardown.
Two payload.rs quality helpers (`QUALITY_UNCERTAIN_MIN`, `is_good`) are
test-only today — `#[cfg(test)]`-gated with a comment saying why.
Local proof: `cargo check --all-targets` with `-D warnings`, `cargo fmt
--check`, `cargo test` (161 + 3 integration) all green.

### 3. Quality Gates — 10 invariant suites

- **ADR-011 entity rule**: `telemetry_archive_events` carries a
  `tenant_id` discriminator → it is PER-TENANT, not cross-tenant. Entity
  drops `schema: 'sensor'`; MODULE_SCHEMAS moves it
  `infrastructureTables` → `tables`; migration 1817 is rewritten
  unqualified + pg_namespace fan-out (1810 pattern). Erasure now drops a
  tenant's archive history with its schema.
- **Farm manifest**: `1808600000000-AddSensorTemperatureEventId` was
  never registered — added to the import + array.
- **Root barrel**: two auth-service files imported
  `EventDedupService` from the bare `@aquaculture/backend-common` root —
  new `event-dedup` subtree alias added to tsconfig paths and used.
- **hr-service**: `syncTenantSchemas: true` was unconditional — gated
  behind `!hrSchemaDdlOwnedByDbMigrate` (PR#363 port, matches
  farm/sensor).
- **1818 vfd index**: touched only the `sensor` source schema; per-tenant
  `vfd_change_sets` never got the guard. Rewritten as source + tenant
  fan-out (1808000000000 pattern) and allowlisted in the DDL guard spec.
- **erasure-ssot**: the literal `forService('sensor-service')` assertion
  rejected the legitimate options-bearing call; tightened to a regex that
  accepts `)` or `,` after the service name (shared-module subscription
  is the property under test).
- **debt-plan contract**: registry tip + active-critical list drifted
  after the ledger re-stitch; truth-table gained 6 rows
  (SENSOR-CRITICAL-086..089 `already-fixed-needs-close`,
  SEC-CRITICAL-092/093 `real-open`), manifest re-pinned via
  `gates:debt-plan:repin`.

Local proof: 10/10 suites green (107 + 19 tests).

### 4. SENS API Gateway CI

- `argon2::verify` does not exist in argon2 0.5 (removed in 0.4.0).
  `verify_pin` now parses with `PasswordHash::new` and verifies with
  `Argon2::verify_password` (same semantics: malformed PHC string →
  reject).
- `cargo audit`: h2 0.4.13 → 0.4.16 (unbounded empty DATA frames).

Local proof: `cargo test --locked --all-targets` with the full CI feature
set builds clean; `cargo update -p h2 --precise 0.4.16`.

## Notes

- The untracked, user-protected migration
  `apps/billing-service/src/database/migrations/1802100000000-AddPlanChangeOperationSaga.ts`
  was not touched and is not part of this commit.
- SENSOR-CRITICAL-086..089 stay OPEN until the post-merge close ceremony
  records main-reachable closing commits (PROC-HIGH-001); their
  truth-table rows say exactly that.

## Addendum — derived-artifact regen round (38177a490) + event anomaly

The 38177a490 push (nats.conf regen, apollo-router artifacts, markdown
wrap, cargo fmt) was accepted by origin but GitHub produced NO
pull_request workflow runs for its SHA — zero check-runs 5+ hours after
the push, while other branches' pull_request runs kept flowing. A PR
close/reopen also produced nothing. The three dispatch-capable heavy
workflows (CI-Full, SENS API Gateway CI, Rust CI) were started manually
against the same SHA, and this follow-up note re-pushes the branch so a
fresh synchronize event re-triggers the pull_request-only gates
(CI-Affected, Quality Gates, NATS SSoT, codegen, Apollo).
