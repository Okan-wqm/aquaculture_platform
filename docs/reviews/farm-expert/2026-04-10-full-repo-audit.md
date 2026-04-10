# Review Report - Farm Expert
**Date:** 2026-04-10
**Scope:** Full repo audit of `apps/farm-service/**`, `web/modules/farm-module/**`, and farm-related shared/event code
**Reviewer:** farm-expert

## Summary
| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 0 |
| LOW | 0 |

## Impact Analysis
The batch lifecycle is mostly hardened now, but three high-impact defects remain in the farm domain:
- batch close semantics still allow a non-harvest lifecycle bypass
- the close mutation passes command arguments in the wrong order, corrupting audit data
- tank allocation still logs over-capacity and proceeds instead of enforcing capacity

## Findings

### [HIGH-001] `closeBatch` still allows premature closure via `OTHER`
- **Files:**
  - [`apps/farm-service/src/batch/resolvers/batch.resolver.ts`](/var/aqua-saas/apps/farm-service/src/batch/resolvers/batch.resolver.ts#L335)
  - [`apps/farm-service/src/batch/commands/close-batch.command.ts`](/var/aqua-saas/apps/farm-service/src/batch/commands/close-batch.command.ts#L11)
  - [`apps/farm-service/src/batch/entities/batch.entity.ts`](/var/aqua-saas/apps/farm-service/src/batch/entities/batch.entity.ts#L423)
  - [`apps/farm-service/src/batch/handlers/close-batch.handler.ts`](/var/aqua-saas/apps/farm-service/src/batch/handlers/close-batch.handler.ts#L71)
- **Description:** The GraphQL mutation exposes `closeBatch` to `MODULE_USER`, and the handler permits `BatchCloseReason.OTHER` from any non-closed status. That means an `ACTIVE` batch can be forced directly to `CLOSED` without the strict lifecycle path defined by `Batch.canTransitionTo()`.
- **Impact:** This bypasses the production lifecycle invariant, can close a batch while biomass is still present, and produces a closed record that does not reflect a harvest-complete or transfer-complete end state.
- **Recommendation:** Restrict `OTHER` to an explicit admin-only override path or remove it entirely from the runtime close flow; enforce the entity transition contract in the handler rather than allowing a broad exception path.

### [HIGH-002] `CloseBatchCommand` arguments are passed in the wrong order
- **Files:**
  - [`apps/farm-service/src/batch/resolvers/batch.resolver.ts`](/var/aqua-saas/apps/farm-service/src/batch/resolvers/batch.resolver.ts#L337)
  - [`apps/farm-service/src/batch/commands/close-batch.command.ts`](/var/aqua-saas/apps/farm-service/src/batch/commands/close-batch.command.ts#L19)
  - [`apps/farm-service/src/batch/handlers/close-batch.handler.ts`](/var/aqua-saas/apps/farm-service/src/batch/handlers/close-batch.handler.ts#L46)
- **Description:** The resolver calls `new CloseBatchCommand(tenantId, id, reason, user.sub, notes)`, but the command constructor is `(tenantId, batchId, reason, notes?, closedBy?)`. As a result, `user.sub` is stored as `notes`, and the free-text notes are stored as `closedBy`.
- **Impact:** The batch audit trail is corrupted: `updatedBy` is populated with notes instead of the user ID, and `statusReason` stores the actor ID instead of the operator note. Any downstream reporting or compliance review that relies on closure metadata will be wrong.
- **Recommendation:** Replace positional construction with a typed object or reorder the call site to match the constructor exactly, then add a regression test for both `notes` and `closedBy`.

### [HIGH-003] Allocate-to-tank still ignores hard capacity enforcement
- **Files:**
  - [`apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts`](/var/aqua-saas/apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts#L127)
  - [`apps/farm-service/src/tank/entities/tank.entity.ts`](/var/aqua-saas/apps/farm-service/src/tank/entities/tank.entity.ts#L376)
- **Description:** The handler computes `availableCapacity`, logs a warning when it is exceeded, and then proceeds anyway. It also never checks the projected density against `maxDensity`. The tank model already has the correct `hasCapacityFor()` contract, which enforces both biomass and density, but the handler bypasses it.
- **Impact:** Over-capacity allocations can still be committed, which breaks the farm capacity model and can create unsafe stocking density in production tanks.
- **Recommendation:** Make capacity violations blocking in the handler and validate both biomass and density through the tank model or an equivalent shared helper. If an override is ever needed, gate it behind an explicit privileged path with audit logging.

## Cross-Domain Dependencies
- `platform-services`: batch closure consumers should be re-validated after the `closeBatch` fix, because current closure metadata is written with the wrong actor/notes mapping.
- `data-expert`: the close-batch audit corruption and allocation capacity enforcement both touch persisted state and should be regression-tested with persistence-backed cases.

## Verification
Static review only. No tests were executed.
