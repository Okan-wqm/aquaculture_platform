# Farm Service E2E Bootstrap Contract Drift

- Date: 2026-05-02
- Affected area: `apps/farm-service/test/*.e2e-spec.ts`, `apps/farm-service/src/app.module.ts`, `libs/storage`, event bus/bootstrap infra
- Status: Fixed for batch GraphQL E2E bootstrap and current batch contract

## Observed Issues

Farm-service GraphQL E2E could not reach business assertions because bootstrap failed in layers before `/graphql` was available:

1. `apps/farm-service/test/*.e2e-spec.ts` were not discoverable by the normal Jest pattern and needed an explicit E2E runner pattern.
2. E2E tests used namespace `supertest` imports that no longer typecheck under the current TS/Jest graph.
3. `libs/storage/src/minio-client.service.ts` imported untyped `minio` directly, leaking third-party declaration gaps into every service compile.
4. `apps/farm-service/src/ai-insights/services/mcp-client.service.ts` dynamically imported untyped MCP SDK subpaths directly from production service code.
5. `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` contained unresolved merge conflict markers and duplicated a nearest-neighbor feeding-rate lookup despite the domain already owning `BilinearInterpolationService`.
6. `FileUploadSecurityService` exposed `policies: readonly UploadPolicy[] = DEFAULT_POLICIES` as a constructor parameter, so Nest tried to resolve an `Array` provider at bootstrap.
7. Farm E2E inherited production `.env` JWT file path `/etc/ssl/jwt/public.pem`; the test host does not have that mounted path.
8. Farm E2E depends on real Postgres, NATS, and MinIO, but the test harness did not own a clear infra contract for host/port/TLS/bucket readiness.
9. `ServiceIdentityGuard` rejected direct E2E GraphQL calls because tests were not sending the gateway HMAC headers.
10. `TenantGuard` rejected E2E GraphQL calls because tests were not sending the gateway `x-user-payload` tenant context.
11. Runtime `farm_service` correctly lacked `CREATE SCHEMA`; E2E tenant provisioning needed a separate provisioning connection instead of broadening runtime database privileges.
12. `farm.equipment_types` contained duplicate `code='heater'` rows, causing tenant reference-data copy to fail on `equipment_types_code_key`.
13. `CodeGeneratorService` and batch transaction handlers opened manual `QueryRunner` instances without a transaction-local tenant search path, causing writes/reads to resolve against the source `farm` schema.
14. `UpdateBatchStatusResolver` passed `user.sub` into the command `reason` slot and `reason` into the `updatedBy` UUID slot.
15. The batch E2E exits successfully but still emits a post-close Jest open-handle warning and `WatchdogRunner` "Driver not Connected" logs after `app.close()`.

## Root Cause

Farm-service E2E was not a first-class test target with its own bootstrap module, env contract, external-service policy, timeout, and dependency overrides. It was trying to run the full production AppModule from ad hoc spec files, so unrelated platform bootstrap dependencies failed before farm GraphQL behavior was exercised.

After bootstrap was made explicit, deeper tenant architecture issues surfaced:

```ts
// Manual QueryRunner paths must pin tenant search_path before ORM use.
await setTenantSearchPath(queryRunner, tenantId);
```

Without that invariant, pooled connections can default to `farm,public`, and schema-less tenant entities or explicit SQL resolve to source tables. SourceSchemaWriteGuard correctly rejects those writes.

## Architectural Fix Direction

- Add a dedicated farm-service E2E Jest config/target that owns `*.e2e-spec.ts`, timeout, setup files, and open-handle behavior.
- Keep real Postgres for tenant/schema behavior, but make NATS and MinIO explicit: either provision reachable TLS-compatible local endpoints with health checks or override them with typed no-op ports where the scenario does not verify event/object-storage behavior.
- Keep production security strict: JWT file-path requirements stay in production; E2E injects a generated inline RS256 public key and deletes stale file-path env.
- Keep third-party SDK type gaps behind local ports/adapters (`minio`, optional MCP SDK) instead of ambient `declare module` shims.
- Reuse domain-owned feeding interpolation service from scheduler instead of maintaining duplicate scheduler math.
- Keep runtime and provisioning DB roles separate. E2E uses `FARM_E2E_DATABASE_*` for the farm runtime role and optional `FARM_E2E_PROVISIONING_DATABASE_*` for schema reset/provisioning.
- Use gateway-equivalent E2E headers, not guard bypasses:

```ts
{
  ...generateServiceIdentityHeaders('gateway-api', secret, tenantId),
  'X-Tenant-ID': tenantId,
  'x-user-payload': JSON.stringify({ sub, tenantId, roles }),
}
```

- Repair reference-data idempotency with data migration plus atomic seed upsert:

```sql
INSERT INTO equipment_types (...) VALUES (...)
ON CONFLICT (code) DO UPDATE SET ...;
```

- Route manual transaction handlers through a shared tenant search-path helper before `manager.findOne()`, `manager.save()`, query builders, or raw SQL.
- Make farm-service watchdog/scheduler lifecycle explicitly test-aware: scheduled infrastructure must stop cleanly during Nest shutdown or be disabled through a production-owned configuration port in E2E.

## Verification Plan

- `npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit`
- `npx jest --config libs/storage/jest.config.ts --runInBand`
- `timeout 180s env ... npx jest --config apps/farm-service/jest.e2e.config.ts --runTestsByPath apps/farm-service/test/batch.e2e-spec.ts --runInBand`

## Current Verification

- `npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit`: passes.
- `npx tsc -p apps/farm-service/tsconfig.e2e.json --noEmit`: passes.
- `npx jest --config libs/storage/jest.config.ts --runInBand`: passes, 18 tests.
- `npx jest --config apps/farm-service/jest.config.ts --runTestsByPath apps/farm-service/src/database/__tests__/code-generator.service.spec.ts --runInBand`: passes, 23 tests.
- `timeout 180s env FARM_E2E_DATABASE_HOST=172.18.0.2 FARM_E2E_DATABASE_USER=farm_service FARM_E2E_DATABASE_PASSWORD=... FARM_E2E_DATABASE_NAME=aquaculture FARM_E2E_PROVISIONING_DATABASE_USER=aquaculture FARM_E2E_PROVISIONING_DATABASE_PASSWORD=... DATABASE_SSL=false npx jest --config apps/farm-service/jest.e2e.config.ts --runTestsByPath apps/farm-service/test/batch.e2e-spec.ts --runInBand`: passes, 9 tests.

## Residual Lifecycle Finding

Batch E2E now verifies the real GraphQL/AppModule/Postgres path and exits with status 0, but Jest still reports an open-handle warning and watchdog logs can appear after shutdown:

```text
Jest did not exit one second after the test run has completed.
WatchdogRunner ... Driver not Connected
```

This is not a batch-domain failure, but it is a farm-service infrastructure lifecycle gap. The enterprise-grade fix is to give watchdog/scheduler infrastructure an explicit shutdown/disable contract for test and service teardown paths instead of relying on process exit.
