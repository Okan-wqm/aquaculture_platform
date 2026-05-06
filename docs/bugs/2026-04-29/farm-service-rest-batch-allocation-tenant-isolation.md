# Farm Service REST Batch Allocation Tenant Isolation

Date: 2026-04-29
Status: Fixed in working tree; verification partially blocked by local dependency type resolution.

## Affected Area

- `apps/farm-service/src/batch/controllers/batch.controller.ts`
- `apps/farm-service/src/batch/services/batch.service.ts`
- `apps/farm-service/src/batch/__tests__/services/batch.service.spec.ts`

## Observed Issue

The REST endpoint `POST /batches/:id/allocate` required `x-tenant-id`, but the controller did not pass that tenant into `BatchService.allocateBatchToTank`.

Inside `BatchService.allocateBatchToTank`, the batch and tank were looked up by ID only. That made the REST path weaker than the GraphQL/CQRS path and could allow a request from one tenant to allocate another tenant's batch or tank if IDs were known.

## Root Cause

The `AllocateBatchInput` service contract did not include `tenantId`, so the service could not enforce tenant-scoped reads. Tenant validation existed at the controller boundary but was not propagated to the domain/service boundary.

## Architectural Fix Direction

The service contract must carry tenant identity for every tenant-owned write operation. Tenant isolation cannot rely only on controller-level header checks.

Implemented direction:

- Add `tenantId` to `AllocateBatchInput`.
- Pass `tenantId` from `BatchController.allocateBatch`.
- Enforce `{ id, tenantId, isActive: true }` on batch and tank lookup.
- Use `input.tenantId` for allocation row creation and `TankBatch` recalculation.
- Update unit test setup to model the transactional `DataSource` path used by allocation.

## Verification Plan

Run focused service tests:

```bash
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/batch/__tests__/services/batch.service.spec.ts --runInBand
```

Current blocker: this workspace's linked `node_modules` is missing the `@nestjs/graphql` declaration entry expected by TypeScript, so the test suite fails before executing farm-service tests.

Observed blocker:

```text
TS7016: Could not find a declaration file for module '@nestjs/graphql'
```

Next enterprise-grade verification step is to restore dependency integrity, not add local declaration shims for third-party packages.
