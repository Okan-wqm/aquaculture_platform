# Validation - 2026-05-20

Planned validation for this PR:

1. Type-check changed files.
2. Run focused frontend build or typecheck for `admin-panel`.
3. Run focused backend test/typecheck for `admin-api-service`.
4. Verify `/admin` has no stale `/admin/audit-log` links.
5. Verify `/admin/analytics` calls:
   - `/analytics/dashboard`
   - `/analytics/tenants/growth?range=...&granularity=...`
   - `/analytics/revenue/trend?range=...&granularity=...`
   - `/analytics/users/activity?range=...&granularity=...`
6. Verify `/admin/analytics/reports` calls:
   - `GET /reports/executions`
   - `POST /reports/executions`
   - authenticated `GET /reports/executions/:id/download`
7. Verify non-platform-admin JWT receives `403` for the three route backend APIs.
8. Verify signed non-access JWT receives `401` before role checks.

## Results

- `BASE_REF=origin/main node scripts/ci/type-check-changed-files.mjs`: passed, 4 project tsconfigs.
- `npx tsc --noEmit -p apps/admin-api-service/tsconfig.app.json`: passed.
- `npx tsc --noEmit -p apps/admin-api-service/tsconfig.spec.json`: passed.
- `npx tsc --noEmit -p web/modules/admin-panel/tsconfig.json`: passed.
- `npx tsc --noEmit -p web/shared-ui/tsconfig.json`: passed.
- `npx nx test admin-api-service --runInBand --testPathPatterns=apps/admin-api-service/src/guards/__tests__/platform-admin.guard.spec.ts`: passed, 30 tests.
- `npx nx test admin-api-service --runInBand --testPathPatterns=apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts`: passed, 18 tests.
- `npx nx build admin-api-service`: passed.
- `npx nx build shared-ui`: passed. Existing Vite dynamic/static import warning for `api-client.ts` remains non-blocking.
- `npx nx build admin-panel`: passed. Existing Rollup `@__PURE__` annotation warnings from shared-ui remain non-blocking.
- Local `npx eslint --max-warnings=0 ...` could not complete in this droplet worktree because the process was killed by the OS after extended type-aware analysis; GitHub file-level lint remains the authoritative gate for this check.

Access validation captured by guard tests:

- Platform admin product actor is represented by auth role `SUPER_ADMIN`.
- Literal `PLATFORM_ADMIN`, `TENANT_ADMIN`, and module roles are rejected by admin-api guard.
- Signed non-access tokens are rejected before role checks.
