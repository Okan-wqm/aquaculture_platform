# Farm — feeding protocol → batch → feed-rate SSoT (Phase 1) — 2026-07-04

Operator model: *"select a protocol when adding a batch; the protocol follows the
fish (moves with it on transfer, ends at harvest) and drives the feed rate from
the fish weight + water temperature."* Investigation found the protocol the
`/sites/feeding?tab=protocols` page manages (`FeedingProtocol`) was a **disconnected
reference catalogue** — no batch/tank assignment path and **no calculation consumer**
— while the real feed rate came from an entirely separate family
(`BatchFeedAssignment` + `Feed.feedingMatrix2D` + `FeedingProgram`). This is the
"Potemkin SSoT — built but unwired" anti-pattern.

## FARM-HIGH-130 — FeedingProtocol was a disconnected catalog (no batch link, no calc consumer) — RESOLVED (Phase 1)

Phase 1 makes the protocol real and the feed-rate SSoT for protocol-assigned batches:

- **Batch ↔ protocol link.** New `Batch.protocolId` (nullable soft reference,
  migration `1802000000000-AddBatchProtocolId`). Because the batch identity
  persists across tank transfers, the protocol **follows the fish automatically**
  and the association **ends when the batch is harvested/closed** — no extra
  "move protocol" logic. Threaded end-to-end: `CreateBatchInput.protocolId` →
  `CreateBatchPayload` → resolver → `CreateBatchHandler` → entity.
- **Protocol picker at batch creation.** `BatchFormModal` (New Batch) gains an
  optional Feeding Protocol dropdown fed by `useFeedingProtocols({ isActive: true })`.
- **Rate SSoT.** New `FeedingProtocolRateService.calculateRate(protocol, avgWeightG,
  waterTempC?)` — `rate% = feedPercent(weightBand) × feedingMultiplier(tempBand)`
  (industry-standard band lookup; weight clamps to nearest band so feed is never
  zeroed at the edges; temperature multiplier defaults to 1.0 when unknown/out of
  band). Pure, dependency-free, 8 unit tests.
- **Wired into BOTH feed-rate paths** that populate the tanks-page batch columns
  (Feed Type / Feed Rate / Daily Feed) — `FeedSelectorService.selectFeedForBatch`
  (fallback + growth-sim/forecast) and the bulk `feed-selection.dataloader`
  (tanks-page primary path). Both give the assigned protocol **precedence** over
  `BatchFeedAssignment`, sharing the one rate SSoT. The rate uses the tank's
  average weight (mixed tanks feed on the aggregate).
- **Seeder bug fixed.** `FeedingProtocolSeederService` wrote `{ minTemp, maxTemp }`
  into the `temperatureRanges` JSONB, but the entity/rate-service expect
  `{ min, max, unit, feedingMultiplier }` — so every seeded protocol silently lost
  its temperature multiplier. Now mapped to the canonical shape at seed time.

**Scope note (not yet wired — later phases, no deferral of Phase 1's slice):**
water temperature currently flows into the tanks-page rate as `undefined`
(multiplier 1.0) — the weight band is the driver; Phase 2 wires real temperature
(manual + sensor). The daily-plan/execution engine
(`daily-feeding-execution.service`) still uses `Feed.feedingMatrix2D`; routing it
through the protocol SSoT is Phase 3.

## Verification
`feeding-protocol-rate.service.spec` 8 green; farm-service batch/feed/feeding
suites 23 green; farm-module 106 green; tsc + eslint clean; `invariants:fast`
142 suites / 1752 tests green (migration-array-completeness + farm-graphql-parity
included).
