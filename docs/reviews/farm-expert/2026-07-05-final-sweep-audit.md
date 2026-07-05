# Farm/Sensor — final sweep audit of the feeding/traceability initiative — 2026-07-05

Two independent audits (farm-domain + security) over every phase delivered in the
initiative (#864..#878 + the open traceability/visibility branch). Verdicts were
verified firsthand against the code, not the commit messages. Findings fixed in
the same branch unless marked tracked-open.

## SEC-HIGH-053 — WaterTemperatureService raw schema interpolation bypassed the fail-closed tenant boundary — RESOLVED
`getCurrentTemperature` built SQL as `"${schema}".table` from
`getTenantSchemaName(tenantId)` WITHOUT the UUID validation that helper's own
contract demands, and was the only farm read not going through `runInTenantRead`.
All reachable tenantId sources are UUID-constrained upstream today (JWT claim,
UUID-validated impersonation header, trusted cron list), so this was a latent
identifier-injection primitive, not a live exploit — but one future
header-sourced caller away from CRITICAL. **Fix (tier-1):** both reads now run
inside `runInTenantRead` with UNQUALIFIED table names (pinned search_path routes
them); the schema string interpolation no longer exists. Spec pins that no
`tenant_`/quoted-schema prefix appears in the SQL.

## SEC-MEDIUM-053 — sensor projection accepted absurd temperatures and future timestamps — RESOLVED
The `sensor_temperature_latest` upsert stored any finite-or-not
`readingTemperature` and any parseable timestamp; the newest-wins guard meant a
single far-future timestamp pinned a wrong value that legitimate readings could
never overwrite — feeding the feed-rate calculation. **Fix:** shared plausibility
bounds (`WATER_TEMPERATURE_MIN_C..MAX_C`, the same SSoT the manual path enforces,
now imported by both) + a +5 min future-skew guard; out-of-range readings are
DROPPED (no DLQ loop). Listener spec +2.

## FARM-HIGH-143 — combined-batch read-model plumbing never shipped; the Phase 5 modals were inert in production — RESOLVED
PR #876 shipped the four batch-aware modals and `BatchScopeSelector`, but the
read-model plumbing (backend `BatchDetailMetric` + `batchDetails` on
`EquipmentBatchMetrics`, resolver map, FE query selection, `TankBatchMetrics` /
`TankWithBatch` types, `tankToTankWithBatch` and the modal converter) had been
swept by a shared-checkout reset BEFORE the commit — so `tank.batchDetails` was
always undefined, `isCombined` always false, and every operation still hit the
primary batch. The modal specs stayed green because they inject `batchDetails`
as a prop. **Fix:** full plumbing re-applied end-to-end; the modal converter
moved to `pages/tanks/types.ts` (exported) and a converter-level spec
(`tank-converters.spec.ts`) now pins the PRODUCTION path
(batchMetrics → TankWithBatch → modal TankBatch) carrying `batchDetails` — the
exact drop can no longer ship silently. Supersedes the premature RESOLVED claim
on FARM-MEDIUM-139.

## FARM-MEDIUM-141 — daily plan scaled the protocol rate with the fabricated 15 °C default — RESOLVED
The tanks page passes `undefined` when no temperature is on record (multiplier
1.0); the daily plan substituted `DEFAULT_TEMP = 15` into the SAME calculator, so
the two surfaces disagreed and rations were scaled by a temperature that was
never measured. **Fix:** `resolveProtocolRatePercent` receives `undefined` when
`usingDefaultTemperature`; the 15 °C fallback stays confined to matrix/curve
interpolation. Spec: a 0.5-multiplier band at 15 °C no longer halves the ration.

## FARM-MEDIUM-142 — traceability summary used row-creation time, not the canonical stockedAt — RESOLVED
`stockedAt`/`daysInProduction` came from `batch.createdAt` + `Math.floor`,
contradicting the entity SSoT (`batch.stockedAt`, `getDaysInProduction()` with
`Math.ceil`) for any backdated stocking. **Fix:** summary now reports
`batch.stockedAt ?? createdAt` and calls `batch.getDaysInProduction()`.

## FARM-MEDIUM-143 — DAILY roll-up never evaluated the feed transition it deferred — RESOLVED
`recordActualFeeding` (DAILY) skipped the transition check with a comment
promising the roll-up would re-evaluate it — the roll-up didn't, so
`programTank.transitionToFeed`, transition stats and the audit log never fired
for DAILY programs. **Fix:** `applyPendingDailyGrowth` loads program relations,
tracks each tank's latest program-bearing execution, and runs
`checkAndExecuteTransitionWithManager` against the rolled-up weight (transition
marked + saved). Roll-up spec +1 (transition fires once with the new avg weight).

## FARM-MEDIUM-144 — dropdown callers reuse the heavyweight fetch-all; batchMetrics resolves temperature per tank — TRACKED-OPEN (owner farm-expert, deadline 2026-07-26)
~10 report modals/tabs call `useTanksList` purely for a tank dropdown and now
page through the full `EQUIPMENT_WITH_BATCHES_QUERY`, whose `batchMetrics`
resolver reads water temperature per tank (2 SQL each, unbatched). Correct shape:
a slim tank-options query for dropdown callers + a DataLoader-batched
`getCurrentTemperatures(tenantId, tankIds)` for the tanks page. Not landed in
this branch; tracked with owner + deadline (no silent deferral).

## Also fixed in this branch (audit LOW tier)
- Traceability per-residency aggregates now run CONCURRENTLY and are bounded by
  `RESIDENCY_LIMIT = 100` with a logged (never silent) truncation.
- DAILY roll-up execution scan carries an explicit `tenantId` predicate
  (defense-in-depth beyond the pinned search_path, matching sibling reads).
- Feed-stock "N low stock" chip counts DISTINCT items, not per-lot rows.

## Orphan-tier notes (documented in docs/reviews/orphan-findings.md)
ORPHAN entries added for: per-event tenant transaction load in the sensor
projection (coalescing only if fleet load materializes); NATS subject↔payload
tenant equality binding (needs an event-bus interface change); manual-temperature
tankId existence validation (data-quality, tenant-isolated by construction).

## Areas both audits verified CLEAN
Protocol→rate SSoT (all three consumers via one calculator, no bypass); DAILY
roll-up idempotency + migration backfill (no double-apply); cron advisory locks +
ordering; traceability tenant isolation + XSS-safe printable report (escapeHtml
SSoT + CSP); list-batches orderBy allowlist + 200 cap; fetch-all loops bounded
(100/page × 50 pages, tenant-scoped cache keys); localStorage normalizers
(no prototype pollution); recordWaterTemperature authz/throttle/bounds.
