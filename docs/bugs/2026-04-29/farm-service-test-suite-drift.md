# Farm Service Test Suite Drift

Date: 2026-04-29
Status: Fixed for farm-service spec compile and updated targeted suites.

## Affected Area

- `apps/farm-service/src/**/__tests__`
- `apps/farm-service/tsconfig.spec.json`
- Linked dependency tree at `/var/aqua-saas/node_modules`

## Observed Issue

Focused verification of `BatchService` is blocked before runtime execution. The workspace has both dependency declaration integrity issues and stale tests that no longer match current farm-service contracts.

Observed commands:

```bash
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/batch/__tests__/services/batch.service.spec.ts --runInBand
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
```

Key failures:

- `@nestjs/graphql` package declares `types: ./dist/index.d.ts`, but the linked package directory does not contain `dist/index.d.ts`.
- Several batch handler tests still instantiate commands with old constructor signatures.
- Some tests reference removed or renamed enum values such as `BatchStatus.STOCKED`.
- Some tests import stale paths or missing test helper package aliases such as `@aquaculture/testing`.
- `CreateBatchHandler` tests expected the removed post-commit `EventBus` path and old `batchCode` / `STOCKED` semantics.
- `CreateBatchHandler` did not enforce positive `initialQuantity` / `initialAvgWeightG` before DB access, so invalid domain input could reach persistence.

## Root Cause

The test suite has drifted behind production code and the shared `node_modules` link is incomplete. Adding local declaration shims or suppressing diagnostics would hide the underlying dependency and contract drift rather than fix it.

## Architectural Fix Direction

Use a dedicated test-suite modernization pass:

- Restore dependency integrity by reinstalling or repairing the linked `node_modules` tree so package-declared type entries exist.
- Update stale tests to the current command constructors, enum names, entity shapes, and CQRS pagination result type.
- Replace obsolete imports with current package aliases or add the intended package alias explicitly.
- Keep test updates contract-based; do not loosen TypeScript settings to make stale tests pass.
- Add missing production invariants at handler boundaries when tests expose real domain gaps; do not make tests pass by weakening expectations.

## Progress on 2026-04-29

- Restored missing package distribution files in the linked `/var/aqua-saas/node_modules` tree instead of adding local declaration shims.
- Added explicit `@aquaculture/testing` path mapping to the shared testing library.
- Updated shared repository/DataSource mock factories to TypeORM's current `ObjectLiteral` generic contract.
- Modernized `BatchService`, `AllocateToTankHandler`, `CloseBatchHandler`, `CreateBatchHandler`, `RecordCullHandler`, `RecordMortalityHandler`, and `TransferBatchHandler` tests to current tenant, transaction, audit-payload, and outbox contracts.
- Replaced stale mortality event assertions that allowed fire-and-forget failures with transactional outbox assertions: enqueue failure now rolls back the command.
- Fixed the `BaseEntity` soft-delete strict-null assertion by explicitly proving `deletedAt` exists after `softDelete()`.
- Aligned farm list handler tests with the platform CQRS pagination contract (`data` + `pagination`) instead of the removed `items/total/page` shape.
- Rewrote `SGRCalculatorService` tests around the current public API (`calculateSGR`, `analyzeSGRTrend`, `compareBatchSGR`) instead of resurrecting unused legacy facade methods.
- Split race-condition event test doubles by real infrastructure role: `RecordMortalityHandler` uses transactional `OutboxPublisher`, while `ConsumeFeedInventoryHandler` uses post-commit `NatsEventBus`.
- Replaced stale v1 batch/tank integration specs with current v2 contract specs covering lifecycle transitions, weight/FCR value objects, closure fields, tank capacity fields, allocation directions, operation directions, and mixed-batch tracking.
- Added production validation in `CreateBatchHandler` for positive initial quantity and average weight before any DB read/write.

## Remaining Open Drift

- `race-conditions.spec.ts` is now aligned with current outbox/NATS infrastructure.
- Batch handler unit specs are now aligned for the fixed slice; remaining failures are e2e/integration/service-contract drift, not the updated handler unit specs.
- Batch integration specs are now v2 contract specs and no longer target removed fields (`STOCKED`, `batchCode`, `currentBiomassKg`, old FCR shape, legacy tank fields).
- `sgr-calculator.service.spec.ts` and `farm/list-farms.handler.spec.ts` are now aligned with current source contracts.

## Enterprise Resolution Plan for Remaining Drift

- E2E race-condition tests: completed by replacing `DomainEventPublisher` mocks with explicit `OutboxPublisher` and `NatsEventBus` test doubles.
- Batch integration fixtures: completed locally in the rewritten v2 contract specs. If more integration specs are added, extract these builders into `@aquaculture/testing` rather than duplicating them.
- Batch lifecycle assertions: completed by testing current lifecycle states and removing deleted pseudo-states such as `STOCKED` and `CANCELLED`.

## Final Verification on 2026-04-29

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/race-conditions.spec.ts --runInBand
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/batch/__tests__/integration/batch-lifecycle.integration.spec.ts --runInBand
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/batch/__tests__/integration/tank-operations.integration.spec.ts --runInBand
```

All commands completed successfully. Jest emitted only the existing Node `punycode` deprecation warning.
- SGR service: completed by rewriting tests to current public API because no production caller uses the removed legacy facade methods.
- Farm pagination: completed by aligning handler tests with the current `PaginatedQueryResult` fields.

## Verification Plan

After dependency integrity is restored and stale tests are modernized:

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/batch --runInBand
npx nx test farm-service --runInBand
```
