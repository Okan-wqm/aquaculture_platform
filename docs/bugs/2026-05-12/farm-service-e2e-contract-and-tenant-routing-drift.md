# Farm Service E2E Contract And Tenant Routing Drift

- Date: 2026-05-12
- Status: Fixed in workspace
- Scope: `apps/farm-service`

## Problem

Farm service batch E2E coverage had drifted away from the production contract:

```text
test/*.e2e-spec.ts booted AppModule directly,
used legacy tenant/test ids,
and did not use gateway service-identity headers.
```

At the same time, several batch command/query paths created their own
`QueryRunner` or repository query builders without explicitly pinning
transaction-local `search_path` to the tenant schema. That allowed E2E and
manual transactions to rely on ambient pool state instead of the canonical
tenant transaction primitive.

## Impact

- Batch GraphQL E2E was not proving the gateway-to-farm boundary.
- Tenant-owned reads/writes could fall back to the source `farm` schema when
  a manually-created transaction missed tenant search-path setup.
- `updateBatchStatus` passed `user.sub` and `reason` in the wrong positional
  slots, so audit/user fields and status reason could be transposed.
- Failed E2E bootstrap could leave background cron/outbox handles alive.

## Resolution

- Rewrote farm batch E2E specs to use `createFarmE2eApp()` and
  `farmE2eHeaders()`.
- Added `farm-service:e2e` target.
- Pinned batch transactional command/query paths through
  `pinTenantTransactionSearchPath()` / `runInTenantTransaction()`.
- Fixed `UpdateBatchStatusCommand` argument order at the resolver boundary.
- Added E2E reference data for tenant site, department, tank, and species.
- Made E2E bootstrap close the Nest app when post-init seeding/provisioning
  fails.
- Disabled watchdog/reference seed during E2E through explicit env gates.

## Verification

```bash
npx tsc -p apps/farm-service/tsconfig.e2e.json --noEmit
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts --runTestsByPath \
  apps/farm-service/src/batch/__tests__/handlers/allocate-to-tank.handler.spec.ts \
  apps/farm-service/src/batch/__tests__/handlers/close-batch.handler.spec.ts \
  apps/farm-service/src/batch/__tests__/handlers/update-batch-status.handler.spec.ts \
  --runInBand
```
