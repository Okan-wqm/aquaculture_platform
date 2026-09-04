# 100-Tenant Readiness v3 — Integration Debt (PR #1338 merge)

Date: 2026-09-03 · Agent: zcode · Cycle: `2026-09-03-branch-evaluation-merge` · Merge:
`feat/100-tenant-readiness-v3` into `claude/branch-evaluation-merge-s5grgw`

## Scope

`feat/100-tenant-readiness-v3` (56 commits) landed Tasks 0–4, 6, 7 and the Task 8 billing core plus
the 2026-08-23 security sweep. Four areas ship **partial** work that the branch's own plan and
review notes describe as done-enough or as "follow-ups" without an owner, a deadline or a tracked
id. Each claim below was verified against the merged tree, not against the branch's prose. All four
are real; each gets a tracked finding here so the debt stops being invisible.

## SENSOR-CRITICAL-108 — declared stream budgets exceed the droplet's JetStream store

**Verified state.** `platform/libs/event-bus/src/nats/nats-event-bus.ts` now declares three streams:
`AQUACULTURE_EVENTS` (1.5 GiB), `AQUACULTURE_TELEMETRY` (`max_bytes` default
`6 * 1024 * 1024 * 1024`) and `AQUACULTURE_DLQ` (default 256 MiB) — about 7.75 GiB of declared
budget. `infrastructure/docker/nats/nats.conf` still sets `jetstream { max_file_store: 2GB }`.
JetStream refuses a stream whose `max_bytes` exceeds the account file-store, so on the droplet the
telemetry stream — the entire 60-minute zero-loss buffer Task 2 exists to provide — cannot be
created at all.

`scripts/deploy/droplet-capacity.sh` still defaults `NATS_REQUIRED_FILE_STORE_BYTES=2013265920`
(1920 MiB = the events-only 1.5 GiB × 1.25). Its own comment names this exact hazard: "When Task 2
lands AQUACULTURE_TELEMETRY (~6GiB …), this default AND infrastructure/docker/nats/nats.conf
max_file_store MUST be raised in the same commit — this gate exists to catch the half-done version
of exactly that change." Task 2 landed; neither value moved. The gate therefore passes a droplet
that cannot hold the streams the code declares.

The sizing inputs are also missing. Both the telemetry and DLQ `max_bytes` comments say the value is
a placeholder "until the Task 0.4 measurement replaces the placeholder", `BROKER_QUEUE_BUDGET_BYTES`
defaults to `0` with the comment "Zero until that operator measurement exists", and
`docs/perf/results/` — the directory Step 0.4 was to write the immutable M/E/R artifact into — does
not exist.

**Owner agent:** zcode (measurement + sizing), architectural-arbiter (resize vs cap decision).
**Owner user:** okan. **Deadline:** 2026-09-17.

**Closure criterion.** All four hold: (1) `docs/perf/results/` carries the Step 0.4 artifact (git
SHA, host identity, payload distribution, measured MQTT wire bytes, Mosquitto persistence delta,
JetStream `/jsz` byte and count delta, rows/message, PG heap/index/WAL delta) for the 2K msg/s × 30
min and the 15K msg/s × 5 min runs; (2) `max_bytes` for `AQUACULTURE_TELEMETRY` and
`AQUACULTURE_DLQ` and `BROKER_QUEUE_BUDGET_BYTES` are derived from that artifact, with the
derivation written down; (3) `nats.conf max_file_store` and `NATS_REQUIRED_FILE_STORE_BYTES` are
raised together to at least the summed declared budgets × 1.25, or the deploy is put in
`PENDING_CAPACITY` behind a recorded droplet-resize/volume decision; (4) a new invariant sums the
stream budgets declared in `nats-event-bus.ts` and fails when `nats.conf max_file_store` or
`NATS_REQUIRED_FILE_STORE_BYTES` falls below that sum × 1.25 — so the next stream addition cannot
repeat this.

## SENSOR-HIGH-105 — the cold archive is columnar-JSONL under Parquet-named files

**Verified state.** The plan's retention contract and Task 6 name "Cold RAW Parquet". The merged
code exports `ARCHIVE_CODEC_ID = 'columnar-jsonl'` from
`apps/sensor-service/src/archive/parquet/telemetry-archive-codec.ts`, and its header comment states
the reason: the Parquet writer dependency could not be installed in the authoring environment. The
directory (`archive/parquet/`) and both services (`telemetry-parquet-exporter.service.ts`,
`telemetry-parquet-verifier.service.ts`) still carry the Parquet name, so the tree reads as Parquet
at every level except the bytes it writes.

The load-bearing guarantees the branch claims — deterministic bytes, manifest + sha256, independent
re-read verification, RAW export — are genuinely present and codec-independent, and the codec id is
stamped in both the header and the ledger manifest, so the seam is real. What is not true is the
format.

**Owner agent:** zcode. **Owner user:** okan. **Deadline:** 2026-10-01.

**Closure criterion.** Either (a) a Parquet codec lands behind the same interface under a NEW format
version tag (`aqua-telemetry-archive/2`), version 1 readers keep working unchanged, and the
exporter/verifier round-trip spec runs against the Parquet path; or (b) Parquet is dropped as the
contract — ADR-024 and the plan's retention table are amended to say `columnar-jsonl`, and the
directory plus both service filenames are renamed off `parquet` so no reader is misled. Partial
credit is not closure: the names and the bytes must agree.

## SENSOR-HIGH-106 — Task 5 produced no load, failure-drill or restore evidence

**Verified state.** None of Task 5's declared outputs exist in the merged tree:
`tools/scripts/telemetry-reconciliation.ts`, `tools/scripts/telemetry-failure-drill.ts`,
`docs/runbooks/telemetry-capacity-and-recovery.md` and
`e2e/tests/integration/telemetry-reconciliation.spec.ts` are all absent, and
`docs/perf/baseline-2026-04.md` is unchanged. That means the 100-tenant steady profile (5.1), the
nine-scenario resilience matrix (5.2), the 15K stress run (5.3), the hardware verdict (5.4), the
RLS/compression decision (5.5) and the WAL-G scratch restore with its RPO ≤ 300 s proof (5.6) have
not been executed or recorded.

Task 5's exit gate is a stated prerequisite of Task 6 (cold storage) and of the sidecar promotion
verdict, both of which the branch nevertheless landed. The zero-loss claim in the plan is therefore
asserted, not measured.

**Owner agent:** zcode (tooling + reconciliation spec), okan (operator-run drills and the external
load host). **Owner user:** okan. **Deadline:** 2026-10-01.

**Closure criterion.** The four Task 5 files exist; a signed, machine-readable reconciliation
artifact for the 2K msg/s × 30 min run shows missing admitted source ids = 0, tenant-minute row
difference = 0, duplicate business effects = 0, unaccounted broker drop = 0 and handler p99 < 5 s /
hard max < 10 s; the resilience matrix records drain time ≤ 60 min with only the expected poison
fixtures in the DLQ; the WAL-G scratch restore records a measured RPO ≤ 300 s against a physical
backup (a logical `pg_dump` does not close this); and the hardware and RLS/compression decisions are
recorded with whatever invariant change each decision implies.

## BILLING-HIGH-002 — Task 8 stops at the billing core, so nothing gates provisioning

**Verified state.** The billing half is real:
`libs/event-contracts/src/billing/telemetry-capacity.ts`,
`apps/billing-service/src/billing/entities/telemetry-capacity-entitlement.entity.ts`, migration
`1802200000000-CreateTelemetryCapacityEntitlements.ts` and `telemetry-capacity.service.ts` with its
`reserve` / `activate` / `release` transitions and same-transaction outbox emit all exist and are
covered.

The admin half does not. `apps/admin-api-service` and `web/` contain zero references to
`TelemetryCapacity`, `sustainedIngressMessagesPerSecond` or `sustainedMetricRowsPerMinute`, so:
there is no device-count × interval × channel-fan-out calculator (Step 8.3), no admin DTO carrying
the derived M/R values, and — most consequentially — the tenant provisioning workflow never calls
`reserve()`. A tenant is therefore still created ACTIVE without any capacity reservation, which is
the precise failure the `PENDING_CAPACITY` state was introduced to prevent. The `SENSOR_READINGS`
meter exists in `apps/billing-service/src/modules/metering/` but is not reconciled against the
approved entitlement anywhere.

The branch's own note (`docs/reviews/zcode/2026-08-28-telemetry-capacity-entitlement.md`) lists
these as "Deliberately out of this core (follow-ups)" with no owner, deadline or tracked id — the
shape `/CLAUDE.md` forbids. This finding supplies all three.

**Owner agent:** zcode. **Owner user:** okan. **Deadline:** 2026-09-24.

**Closure criterion.** All four hold: (1) `tenant-provisioning-workflow.service.ts` calls
`reserve()` inside the existing provisioning transaction and surfaces `PENDING_CAPACITY` instead of
activating an over-envelope tenant, with the plan's two Step 8.1 scenarios as passing specs; (2) the
admin DTO carries `sustainedIngressMessagesPerSecond` and `sustainedMetricRowsPerMinute` and the
admin UI exposes the device × interval × fan-out calculator writing the derived values onto the
quote; (3) the `SENSOR_READINGS` meter's committed row usage is reconciled against the active
entitlement, with drift alerting as the plan's "meter/usage drift" alarm requires; (4) an invariant
fails if a tenant-provisioning path can reach ACTIVE without a capacity reservation row.

## Reconciled with main's SENSOR-HIGH-104 (db-migrate aggregate authority)

Main landed `99493b58b` + `54258b094` after this branch was cut: the per-tenant continuous-aggregate
DDL moved to `libs/backend-common/src/database/sensor-continuous-aggregate-definition.ts` (the single
statement list), db-migrate creates and owner-aligns the rollups on an autocommit connection
(`tenant-sensor-continuous-aggregate-authority.ts`, called from the fan-out phase and from both
provisioner job paths), and the sensor-service boot pass is a read-only fail-closed verifier whenever
db-migrate is authoritative. That is the same ownership move this branch's Task 4 made, done one layer
lower, so the merge keeps main's structure and drops the branch's duplicates:

- The provisioner's `ensureTenantContinuousAggregates` + `TENANT_CAGG_STATEMENTS` mirror is removed.
  It ran the same DDL under a different advisory-lock key, with no owner alignment, one loop
  iteration before main's authority step ran it again.
- `SENSOR_CAGG_BOOT_RECONCILE` is removed. Main's `SENSOR_CONTINUOUS_AGGREGATES_ENABLED` already
  gates the non-authoritative creation sweep, and the authoritative verify pass is the SENSOR-HIGH-104
  contract, which must not be switchable off.

Kept from this branch, now on the shared definition and service: the refresh `start_offset`
widening (3m/3h/3d to 24h/7d/30d, late-replayed edge telemetry), tenant-addressed
`getRefreshStatus(tenantId)` / `refresh(tenantId, ...)`, and the lower-tier retention-horizon refusal
in `refresh`. `continuous-aggregate.service.spec.ts` covers the tenant-addressed paths.

## Not a debt claim, but recorded: SENSOR-HIGH-097 has no anchor and no registry row

Commit `65753cb90` ("chore(sensor): close the erasure Swiss-cheese holes in the telemetry path")
carries `Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-097`, but that
review file has no `SENSOR-HIGH-097` heading and the branch added no registry row for it. The work
the commit describes is present in the tree; only the traceability record is missing. The integrator
should either add the anchor plus a registry row during the hash-chain ceremony, or repoint the
trailer at the finding the work actually closes.
