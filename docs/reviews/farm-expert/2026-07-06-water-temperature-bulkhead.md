# Water-temperature enrichment bulkhead (2026-07-06)

## FARM-HIGH-136 — temperature-source failure aborted core reads: batchMetrics blanked + tenant-wide feeding kill
equipmentList.batchMetrics awaited waterTemperatureService.getCurrentTemperature OUTSIDE its enrichment try/catch
(equipment.resolver.ts:391), and daily-feeding-execution getWaterTemperature (:1380) had no catch — so one
infrastructure failure of a temperature source (LIVE: missing grant on sensor_temperature_latest,
INFRA-CRITICAL-039) nulled the ENTIRE batchMetrics field (mobile lost all fish counts while tank_batches was
healthy) and failed EVERY tank's daily feeding plan tenant-wide (the designed default-15°C degradation was
reachable only on null, not on throw). ADVERSARIALLY VERIFIED (multi-agent audit).

FIX (Tier-2, at the SSoT so every current and future caller inherits): each source read in
WaterTemperatureService now runs under its own SAVEPOINT — a plain try/catch is NOT enough because Postgres
aborts the surrounding READ COMMITTED transaction after an error (25P02 poisons the sibling read) — and an
infrastructure failure degrades to null-for-that-source LOUDLY: structured Logger.error +
farm_water_temperature_read_failures_total{source} (FarmDomainMetricsService; alert on rate > 0). Both callers
now degrade naturally: batchMetrics keeps its core count fields; feeding falls into its existing
default-temperature path (usingDefaultTemperature flag preserved). The tenant boundary (runInTenantRead) stays
fail-closed. Spec 10/10 (source-fail→other-source, both-fail→null-not-throw, savepoint release/rollback,
metric); feeding+metrics consumer specs 27/27; tsc 0.
