# INFRA-HIGH-027: Tenant erasure proof ledger missed schema ownership SSoT

## Finding

DigitalOcean deploy run `27971487289` rebuilt and verified the selected service
images, passed capacity preflight, and started the deployment, but the critical
health gate failed. `hydroponics-service` restarted because strict source-schema
ownership reported `hydroponics.tenant_erasure_target_proofs` as an orphan table.

## Root Cause

`tenant_erasure_target_proofs` is not stale data and must not be dropped. It is
the durable per-target tenant-erasure proof ledger created by the shared outbox
DDL producer and consumed by the tenant-erasure executor. The executor registry
declared that ledger for every target service, but `MODULE_SCHEMAS` did not list
the proof ledger as source-schema infrastructure. That left strict ownership with
two divergent truths: tenant erasure considered the table required, while schema
bootstrap considered it undeclared.

## Fix

`MODULE_SCHEMAS.infrastructureTables` now consumes the shared
`TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE` producer for every tenant-erasure
target schema. The invariant in `tenant-erasure-ssot.spec.ts` verifies that every
target registry proof ledger is declared as source-schema infrastructure and is
not cloned through the per-tenant `tables` list.

## Verification

- `git diff --check`
- `npm run findings:verify`
- `npm run type-check`
- `npm run codegen:check`
- `npm run gates:type-check-spec`
- `npm run gates:all`
- `npx jest --config tests/invariants/jest.config.ts --runTestsByPath tests/invariants/tenant-erasure-ssot.spec.ts --runInBand`
- `npx jest --config apps/farm-service/jest.config.ts --runTestsByPath apps/farm-service/src/compliance/__tests__/tenant-erasure.service.spec.ts apps/farm-service/src/compliance/__tests__/tenant-erasure-requested.handler.spec.ts --runInBand`
- `npx jest --config libs/backend-common/jest.config.ts --runTestsByPath libs/backend-common/src/nats/__tests__/nats-v3-wire-compat.spec.ts --runInBand`
- `node tools/toolchain/run.mjs eslint apps/farm-service/src/compliance/services/tenant-erasure.service.ts libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-registry.ts libs/backend-common/src/database/schema-manager.service.ts libs/backend-common/src/nats/nats-v3-server.strategy.ts tests/invariants/tenant-erasure-ssot.spec.ts tests/invariants/jest.config.ts`
