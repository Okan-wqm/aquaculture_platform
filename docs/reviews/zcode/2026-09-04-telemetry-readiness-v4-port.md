# 100-Tenant Readiness — v4 salvage onto the v3 head

Date: 2026-09-04 · Agent: zcode · Cycle: `2026-09-04-tenant-readiness-v4-salvage` · Base:
`claude/branch-evaluation-merge-s5grgw` (`d97d8ff91`)

## Scope

`feat/100-tenant-readiness-v4` (9 commits, never merged) re-implements the same programme the
merged `feat/100-tenant-readiness-v3` already put on this head, with its own archive subsystem,
ingest ledger and admission path. Two competing subsystems cannot coexist, so the branch is not
merged. Three pieces of it are worth keeping and are evaluated here against what this head
actually carries — not against v4's prose.

## SENSOR-HIGH-109 — the readiness envelope had no reader, so an unrun gate looked like a pass

**Verified state (before this pass).** Task 5 of
`docs/reviews/zcode/2026-08-24-100-tenant-readiness.md` states the whole readiness envelope as
prose: 2 000 msg/s for 30 minutes with a reconciliation artifact (5.1), a nine-scenario resilience
matrix (5.2), a 15 000 msg/s five-minute stress run (5.3), four hardware ratios with a
resize-versus-volume branch (5.4), the RLS/compression rule (5.5) and the WAL-G scratch restore with
its RPO ≤ 300 s (5.6). Task 3's exit gate adds the sidecar promotion criteria (parity, p99 no worse
than Node, CPU per message at least 20 % lower).

Nothing in the tree read any of it. `tools/scripts/` had no readiness evaluator, `tools/gates/` had
no readiness spec, and the head's own `SENSOR-HIGH-106` records that none of Task 5's artifacts
exist. The consequence is the one that matters: a run that was never performed, a run that was
performed and failed, and a run that passed were all indistinguishable to CI, so "zero loss" could
be claimed at merge time by anyone willing to write the sentence.

**Resolution.** `tools/scripts/evaluate-telemetry-readiness.ts` scores one JSON evidence document
against the plan's numbers and exits non-zero on any violation;
`tools/gates/telemetry-readiness-gate.spec.ts` runs the real script over synthetic evidence and pins
both directions — a fully-passing envelope is accepted, and every shortcut is refused: a missing
admitted source id, a duplicated business effect, an unclassified stress message, a drain that
overruns 60 minutes or misses the derived 4 000 msg/s committed floor, a compressed raw table, a
`pg_dump` standing in for the physical restore, a fault scenario dropped from the matrix, a sidecar
promotion assembled from runs of different builds, and negative timing/resource/RPO values. The gate
runs per PR because `tools/gates/run-all.mjs` globs this directory and `npm run gates:test` is
invoked by `.github/workflows/closes-footer-check.yml`.

The evidence schema is anchored on THIS head, not on v4:

- nine fault scenarios, matching Task 5.2's list (v4 declared eight — it folded "restore and measure
  drain time" into the buffer scenario);
- `sustained.maxEndToEndSeconds` below 10 s alongside the p99 below 5 s, because 5.1's pass line
  names both;
- `stress.corrupted` alongside crash/OOM, because 5.3 names corruption;
- `recovery.committedMps` derived as `newIngressMps + initialBacklogMessages / 3600` rather than a
  hardcoded 4 000, so the floor follows the evidence's own backlog;
- `compression.target` restricted to `tenant-scoped-aggregate` or `cold-storage`, because 5.5 keeps
  raw uncompressed under FORCE RLS whatever the benchmark says;
- `walgRestore.archiveLedgerSurvived` refers to this head's `sensor.telemetry_archive_events`
  lifecycle ledger;
- `environment.activeEntitlementTenants = 100` refers to this head's billing telemetry-capacity
  entitlement;
- sidecar promotion requires at least one run and every recorded run to pass on the same
  host/image/config, matching Task 3's exit gate (v4 demanded exactly three runs — a run-count this
  head's plan never states).

**Owner agent:** zcode. **Owner user:** okan. **Deadline:** 2026-09-04 (closed by this pass).

**Closure criterion.** The evaluator and its gate spec exist, the gate spec runs from
`npm run gates:test`, and the spec fails when any single clause of the envelope is weakened. All
three hold.

## OBS-MEDIUM-003 — droplet container alarms sit above the Task 5.4 readiness ceilings

**Verified state.** Task 5.4 fixes the hardware ceilings at p95 CPU ≤ 70 % and working-set memory
≤ 75 %. `infrastructure/monitoring/droplet/rules/30-resources.yml` fires `HighCpuUsage` at `> 0.8`
of the compose CPU quota and `HighMemoryUsage` at `> 0.85` of the memory limit. A droplet can
therefore sit between the readiness ceiling and the alarm threshold — outside the envelope the
100-tenant capacity decision was made on — with nobody paged, until the next readiness run
discovers it retroactively.

v4 coupled the two by rewriting `30-resources.yml` down to 0.70/0.75 in the same branch as its
readiness gate, and its gate spec asserted the two agreed. That rewrite is a live alerting-policy
change for every `aqua-*` container, which is a product decision about page volume, not a
consequence of porting an evidence reader — so this pass ported the gate and left the alarm
thresholds alone rather than changing operator paging behaviour as a side effect. The disagreement
is recorded here instead of being silently dropped.

**Owner agent:** zcode (the invariant), architectural-arbiter (whether the ceilings and the pager
thresholds should be the same number at all). **Owner user:** okan. **Deadline:** 2026-10-15.

**Closure criterion.** Either the droplet container CPU/memory alarm thresholds are moved to at or
below the Task 5.4 ceilings and a spec asserts that
`tools/scripts/evaluate-telemetry-readiness.ts`'s ceilings are never looser than the shipped alert
expressions, or an ADR records why the pager threshold is deliberately above the capacity ceiling
and names the compensating control that notices the gap. Leaving both numbers in the tree with no
stated relationship is not closure.

## Parquet codec — v4 is stronger, and why it is not in this pass

The head's `SENSOR-HIGH-105` (from `2026-09-03-100-tenant-readiness-integration.md`) offers two
closure routes; route (a) is "a Parquet codec lands behind the same interface under a NEW format
version tag". v4's
`apps/sensor-service/src/telemetry-archive/telemetry-parquet-codec.service.ts` is that codec: real
`@dsnp/parquetjs` columnar output, `PAR1` magic-byte checks at both ends of the file, format and
schema-version stamped in the Parquet key-value metadata, a typed row decoder, an `inspect()` that
re-reads row count and min/max time from the stored object, and a 22-column RAW schema against this
head's 10-column projection. It is materially stronger than
`apps/sensor-service/src/archive/parquet/telemetry-archive-codec.ts` on every axis the finding
names, and it was verified to work in this environment (`@dsnp/parquetjs@1.8.8` installs cleanly —
62 packages, no native build, 0 advisories — and round-trips writer→reader including optional
columns and custom metadata).

It was NOT ported in this pass, and the reason is environmental, not architectural: the port
requires `@dsnp/parquetjs` in the root `package.json`, and this worktree cannot install it. Its
`node_modules` is a symlink to the shared checkout, and `npm install @dsnp/parquetjs --dry-run`
reports the reconciliation it would perform against that shared tree as "added 984 packages, removed
2 packages, and changed 2068 packages" — a rewrite of another worktree's dependency tree. Adding the
dependency to `package.json` without installing it would leave `tsc`, `eslint` and every
sensor-service jest suite unable to resolve the import, which is a red tree, and shipping the codec
without running its round-trip spec would be exactly the unverified claim `SENSOR-HIGH-105` exists
to stop.

`SENSOR-HIGH-105` therefore stays OPEN at its existing deadline (2026-10-01) with its owner
unchanged, and this section is the evidence for whoever picks it up: the codec to port is
`git show origin/feat/100-tenant-readiness-v4:apps/sensor-service/src/telemetry-archive/telemetry-parquet-codec.service.ts`,
the dependency line is `"@dsnp/parquetjs": "1.8.8"` with a `thrift` → `uuid` override, and the work
must land in a checkout with a writable `node_modules` so the exporter/verifier round-trip spec
actually runs against the Parquet path.

## Receipt/dispatch ledger — design ported into the plan

v4's plan (`22a74cbeb`) specifies a per-tenant `sensor_ingest_receipts` + `sensor_event_dispatch`
pair that this head's Task 1 does not have: the head holds PUBACK until the metric write commits,
but it has no durable record of which source ids were accepted, no durable record of which child
events still owe a JetStream PubAck, and therefore no way for a process that crashes between commit
and publish to know what it still has to publish. That is a design gap in the head, not a competing
implementation, so the design (and only the design — no speculative code) is recorded as Task 1.9 in
`docs/reviews/zcode/2026-08-24-100-tenant-readiness.md`, tracked under the existing
`SENSOR-CRITICAL-086`/`SENSOR-CRITICAL-087` findings that own the ACK-after-commit contract.
