# Harvest edit corrupts live stock — farm-expert, 2026-09-08

Surfaced while implementing FARM-HIGH-198 (`tank_operations('harvest')` mirror left
un-reversed on cancel/edit). The mirror is real, but it is the smallest of five stale
surfaces on the edit path, so the edit half of 198 is recorded here in its true shape.

## FARM-CRITICAL-322 — `updateHarvestRecord` mutates harvested quantity without moving any stock

`UpdateHarvestRecordHandler` (119 lines) imports no `Batch`, no `Tank`, no `TankBatch`,
no `TankBatchService` and no `FarmStockProjectionService`. It locks the harvest row,
copies `UPDATABLE_FIELDS` onto it, saves, and enqueues `HarvestRecordUpdatedEvent`.

`quantityHarvested`, `totalBiomass` and `averageWeight` are in that updatable set
(`update-harvest-record.handler.ts:36-38`) and on the GraphQL wire
(`update-harvest-record.input.ts:43,50,58`), dispatched from
`harvest.resolver.ts:377-400` behind `@Roles(TENANT_ADMIN, MODULE_MANAGER)`.

Editing a harvest from 100 fish to 50 therefore leaves every downstream surface at the
original number:

| Surface                                                         | Written by the create path                                  | Adjusted on edit |
| --------------------------------------------------------------- | ----------------------------------------------------------- | ---------------- |
| `batch.currentQuantity` / `harvestedQuantity` / `retentionRate` | `create-harvest-record.handler.ts:366-371`                  | no               |
| `tank_batches.batchDetails[]` + aggregates                      | `applyBatchDelta`, `create-harvest-record.handler.ts:390+`  | no               |
| `tank.currentBiomass` (and derived `currentCount`)              | `create-harvest-record.handler.ts:411-417`                  | no               |
| `tank_operations(HARVEST)` mirror                               | `create-harvest-record.handler.ts:349-364`                  | no               |
| farm-stock projection                                           | `refreshContainers`, `create-harvest-record.handler.ts:418` | no               |

This is the FARM-HIGH-104 divergence class — the drift `TankBatchService.applyBatchDelta`
was made the single writer to prevent — reachable from a supported operator edit rather
than from a race.

`update-harvest-record.handler.spec.ts:50,96` edits `quantityHarvested` 500 -> 600 and
asserts only the event's `changedFields`, so no test observes the stock at all.

### Why the fix is removal, not compensation

Cancel (`delete-harvest-record.handler.ts`) already reverses batch aggregates, tank
composition and tank biomass correctly through `applyBatchDelta`, and create applies
them forward. A quantity correction is expressible today as cancel + re-create, using
two paths that are already correct and tested. Teaching the edit path to compute and
apply a third stock delta would add a third writer to maintain in lock-step with the
other two — the shape of the defect, not its cure.

Removing the three fields makes the corrupt state unreachable (tier 1) instead of
merely detected. No hand-written client selects them: the only references under `web/`
are generated types.

## FARM-HIGH-198 — the cancel half, and what it actually needs

`delete-harvest-record` is otherwise correct; its single gap is the
`tank_operations(HARVEST)` row, which stays `isDeleted = false` after cancellation, so
that ledger over-counts removals.

Every consumer already honours the flag — `fcr-calculation.service.ts:373`,
`get-tank-operations.handler.ts:45`, `get-batch-history.handler.ts:92,143`,
`get-stock-events-summary.handler.ts:71`, `get-todays-daily-ops-counts.handler.ts:59` —
so soft-deleting the paired row withdraws it everywhere.

What is missing is the link: `tank_operations` carries no `harvestRecordId`, so a
cancel has no structural way to find its row. Matching on
(tenant, tank, batch, date, quantity) is ambiguous for two same-day harvests of equal
size and is a heuristic where a foreign key belongs.
