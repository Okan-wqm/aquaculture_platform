# Stock-integrity fixes from the 2026-07-06 end-to-end audit

## FARM-HIGH-137 — DeleteHarvestRecord was repeatable: CANCELLED re-delete double-restocked batch + tank
The status guard blocked only DISPATCHED/DELIVERED; CANCELLED passed, and the record was read OUTSIDE the
transaction with no lock — a double-click / client retry / concurrent pair re-added quantityHarvested to the
batch AND the tank on every call. A missing batch row was silently skipped (half-reversal: tank restocked, batch
aggregates untouched). FIX: the record is read INSIDE runInTenantTransaction under pessimistic_write; the
reversal is gated on an atomic not-yet-CANCELLED → CANCELLED transition (already-CANCELLED → BadRequest);
missing batch → NotFound (refuse partial reversal). Spec: CANCELLED-rejection + no-side-effects assertions.

## FARM-HIGH-138 — per-tank overdraft was silently clamped, permanently diverging batch vs tank aggregates
Removal handlers validate only the batch-GLOBAL count; applyBatchDelta clamped the per-tank share with Math.max
(200 mortality against an 83-fish tank share → clamped to 0, 117 fish silently absorbed; batch.currentQuantity
kept the full 200 subtraction → permanent divergence). FIX (Tier-1, in the single writer so EVERY caller is
covered): a negative quantityDelta exceeding the batch's share in the tank throws a domain error; removal from a
batch not present in the tank (old silent no-op) also throws. Math.max remains only as a float-noise floor for
biomass. Exact-to-zero removal still allowed (batch leaves the composition). Specs: overdraft-reject,
absent-batch-reject, exact-zero-allowed.

## FARM-HIGH-139 — createBatch initialLocations is still a second tank_batches writer (tracked, owner+deadline)
The existing-TankBatch branch hand-mutates totalQuantity/totalBiomassKg/avgWeightG + pushes batchDetails without
a lock, never refreshes the currentQuantity/currentBiomassKg mirrors, and full-saves Equipment (clobber risk).
FIX DESIGN: route each initial location through applyBatchDelta (positive delta; capacity flags via a
column-scoped update), drop the handler's independent count writes, add create-batch to the single-writer
invariant scope. NOT in this PR: the branch is entangled with the bulk-write/legacy-tank path and needs its own
spec surface; landing it hastily risks the batch-creation flow. Owner: farm-expert. Deadline: 2026-07-13.
