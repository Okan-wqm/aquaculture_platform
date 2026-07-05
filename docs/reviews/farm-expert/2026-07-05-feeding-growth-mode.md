# Farm — FCR-based feeding growth: per-feeding vs daily roll-up (operator-selectable) — 2026-07-05 (Phase 8)

`recordActualFeeding` already grew the fish (biomass += fed / FCR → avg weight up)
on every recorded feeding, and Phase 1/3 made the feed RATE protocol-driven. The
operator asked to CHOOSE, per feeding program from the frontend, whether that
growth rolls into the tank weight immediately (per feeding) or once at day end.

## FARM-MEDIUM-140 — feeding growth was always applied per-feeding; make it operator-selectable (per-feeding vs daily roll-up) — RESOLVED (Phase 8)

**Model.** The DAY-END TOTAL growth is identical either way (growth is linear in
feed); the mode only controls WHEN the avg weight rolls up — which changes the
weight that mid-day plan regens and the tanks page see.

**Backend.**
- `GrowthApplicationMode` enum (`PER_FEEDING` | `DAILY`) on `ProgramSettings`
  (per-program, defaults PER_FEEDING) + runtime validation + `ProgramSettingsInput`
  GraphQL field, threaded through the create/update program service.
- `DailyFeedingExecution.growthAppliedAt` timestamp (migration
  `1802400000000`, nullable, blue-green). **The migration backfills every existing
  completed execution** (`growthAppliedAt = COALESCE(completedAt, updatedAt)`) —
  their growth was already applied inline, so this stops the new roll-up from
  double-applying it. This timestamp is the idempotency key.
- `recordActualFeeding` branches on the mode: PER_FEEDING applies growth now +
  stamps `growthAppliedAt` (unchanged behaviour); DAILY records the feed + deducts
  inventory but HOLDS BACK the weight update + feed transition, leaving
  `growthAppliedAt` null.
- `applyPendingDailyGrowth(tenantId)` sums each tank's pending growth
  (Σ fed / clamped-FCR), applies ONE weight update to the still-morning biomass,
  and stamps every processed execution — idempotent (safe to re-run). A 05:00 cron
  (`applyDailyGrowthRollup`, before the 06:00 plan) discovers tenants with pending
  growth per schema and calls it.

**Frontend.** A "Buyume Guncellemesi (FCR)" select on the feeding-program form
(per-feeding / daily), sent as `settings.growthApplicationMode` and read back
(JSON blob → uppercase-normalized) on edit.

## Verification
`applyPendingDailyGrowth` 3 (sums 2 executions into one +9 kg update / 109 g;
no-pending no-op; zero-fed stamped-not-grown); `recordActualFeeding` DAILY-holds back
+ PER_FEEDING-inline; feeding suites 22; farm-module green; tsc + eslint clean;
invariants (migration-array-completeness + schema-drift + supergraph) green.
