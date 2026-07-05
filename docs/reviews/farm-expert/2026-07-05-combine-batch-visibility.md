# Farm — combined-batch (B-1 + B-2) visibility + correct per-batch operation attribution — 2026-07-05 (Phase 5)

The backend already tracks several batches in one tank (`TankBatch.batchDetails[]`
SSoT + per-batch mortality/cull attribution + feed on tank-average weight). But
the read model and the operation modals collapsed everything onto the PRIMARY
batch, so combined tanks were invisible and every operation silently mis-booked.

## FARM-MEDIUM-139 — combined batch invisible in the read model, and tank operations mis-attributed to the primary batch — RESOLVED (Phase 5)

**Two coupled defects.**
1. `EquipmentBatchMetrics` exposed only the primary batch (`batchNumber`/`batchId`
   + an `isMixedBatch` flag) — never the `batchDetails[]` breakdown — so the tanks
   page could not show "B-1 + B-2".
2. The Mortality / Cull / Transfer / Grading modals hardcoded `tank.primaryBatchId`
   in their mutation input and validated quantities against the tank TOTAL. On a
   combined tank they booked the loss/move against the wrong batch's ledger and let
   the operator remove more fish than a batch actually held.

**Fix (read-model SSoT + typed exposure).**
- New typed GraphQL `BatchDetailMetric` ObjectType (batchId, batchNumber, quantity,
  avgWeightG, biomassKg, percentageOfTank) + `batchDetails` field on
  `EquipmentBatchMetrics`; the resolver maps `tankBatch.batchDetails` straight
  through. Not `GraphQLJSON` — a real, queryable type.
- FE plumbing: `batchDetails` flows query → `TankBatchMetrics`/`BatchDetail` →
  `types.ts` mapper → `TankWithBatch` → the `tankWithBatchToTankBatch` converter
  (which previously dropped it). Tanks-page batch cell renders the combined
  "B-1 + B-2" label when >1 batch shares the tank.
- New reusable `BatchScopeSelector` (renders nothing for a single-batch tank, so
  non-combined behaviour is byte-identical). Wired into all four modals with a
  `selectedBatchId` (defaulting to the primary): the mutation now sends the SELECTED
  batchId, and every quantity / biomass / avg-weight — the max input, the quick-select
  percentages (Transfer), the per-row max (Grading), the before/after figures, and the
  over-stock validation — is scoped to the selected batch's share. You can no longer
  transfer or grade out more fish than the chosen batch holds.

## Verification
MortalityModal 6 (single-batch selector hidden; selecting B-2 sends `batchId: batch-2`,
not the primary; 800 > B-2's 500 share is blocked even though < the 1500 tank total);
farm-module 27 files / 110 tests; farm-service equipment 13; tsc + eslint clean;
`invariants:fast` 142 suites / 1752 tests (parity: `batchDetails` is a nested field,
no allowlist needed).
