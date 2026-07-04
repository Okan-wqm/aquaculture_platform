# Farm — daily-plan/execution engine uses the batch protocol as the rate SSoT (Phase 3) — 2026-07-04

Phase 1 (`2026-07-04-protocol-batch-feeding-ssot.md`) made the tanks-page feed
columns protocol-driven. But the daily-plan / execution ENGINE
(`DailyFeedingExecutionService.calculateDailyFeed`) still derived its rate purely
from `Feed.feedingMatrix2D` / `feedingCurve`, so the daily plan and the tanks page
could disagree on the same tank's feed rate. Phase 2 wired real water temperature;
this phase routes the engine through the protocol.

## FARM-MEDIUM-137 — daily-plan/execution engine ignored the batch's feeding protocol (diverged from the tanks page) — RESOLVED (Phase 3)

**Fix.** `calculateDailyFeed` now applies protocol precedence for the RATE: after
computing the feed-derived rate (matrix/curve, unchanged), it resolves the tank's
primary-batch protocol and, when present, overrides the rate with
`FeedingProtocolRateService.calculateRate(protocol, avgWeightG, waterTempC)` — the
SAME stateless calculator the tanks-page DataLoader uses, so the daily plan and the
tanks page now agree. The protocol lookup (`resolveProtocolRatePercent`) is
schema-qualified (`getTenantSchemaName`), so it is safe from the daily-feeding cron
(no request search_path). FCR stays feed/program-derived (the protocol carries no
FCR model). When the batch has no protocol, the engine keeps its existing behaviour
exactly.

**Batch columns.** The tanks-page `EquipmentBatchMetrics` already declares every
column the operator asked for (species, pieces, avg weight, biomass, density,
survival/mortality, FCR, SGR, feedCode/feedName/feedingRatePercent/dailyFeedKg,
last feeding/sampling/mortality, days-since-stocking, capacity). They are populated
by `batchMetrics`; the feed columns became protocol-driven in Phase 1. No structural
gap — the columns fill from live data.

## Verification
`daily-feeding-execution.protocol-rate` 3 (no-protocol keeps feed rate; protocol
overrides; no-batch skips the lookup); daily-feeding + feeding-protocol-rate +
feed-selection suites 25 green; tsc + eslint clean. No new migration/entity/FE
surface — a farm-service-internal engine change.
