# E2E And Admin Test Harness Drift

- Date: 2026-04-29
- Affected area: `e2e/`, `apps/admin-api-service/src/**/__tests__`
- Status: Fixed for admin targeted specs and E2E compile/discovery contracts; root dependency audit remains separately recorded

## Observed Issue

Full `e2e/tsconfig.json --noEmit` fails with many unrelated harness type errors: missing helper exports, outdated GraphQL helpers, Playwright type gaps, JWT overload drift, and outdated `TestDatabase` APIs. Full `apps/admin-api-service/tsconfig.spec.json --noEmit` also fails outside the tenant provisioning scope on impersonation and provisioning-saga spec type drift.

During implementation, `playwright test --list` also exposed a runner-boundary bug: Playwright tried to load Jest-style Node/GraphQL/DB specs that use global `describe(...)`, resulting in `ReferenceError: describe is not defined` and zero listed tests.

## Root Cause

The test harness API evolved inconsistently across E2E and service specs. Several suites reference older helper shapes instead of the current production contracts.

The E2E suite also mixed two runner contracts in one Playwright config:

- Playwright-native HTTP/security specs import `test` from `@playwright/test`.
- Node-style GraphQL/DB/module specs are Jest suites using global `describe`, `it`, and `expect`.

## Architectural Fix Direction

The touched tenant provisioning harness was aligned with production DI by adding `TenantSchemaRepository` and `BackupRestoreService` mocks.

The broader admin harness drift was fixed by aligning impersonation and provisioning-saga specs with production contracts instead of weakening strictness:

- `ImpersonationController` now has explicit class-level `@UseGuards(PlatformAdminGuard)` metadata.
- The isolated impersonation spec now mocks the full service surface, including `extendSession`, and asserts the real `validateSession` argument shape.
- Provisioning saga tests now use guarded array access helpers instead of unsafe strict-null assertions.

The E2E helper layer was made a canonical facade:

- GraphQL helper supports Playwright request contexts and raw/successful HTTP modes explicitly.
- REST helper supports Playwright request contexts without relying on fetch-only assumptions.
- JWT helper supports the token shapes used by integration/security tests.
- DB helper restores the shared `TestDatabase` and standalone query facade expected by existing suites.

The runner boundary is now explicit:

- `e2e/playwright.config.ts` discovers only Playwright-native security tests.
- `e2e/jest.config.ts` owns Node/GraphQL/DB E2E suites and ignores `tests/security`.
- `e2e/package.json` routes `test:security` through Playwright and `test:node`/`test:workflow`/`test:integration` through Jest.

## Verification

- `npx tsc -p e2e/tsconfig.json --noEmit` passes.
- `npx playwright test --config playwright.config.ts --list` from `e2e/` lists 27 security tests in 7 files.
- `npx jest --config jest.config.ts --listTests` from `e2e/` lists Node/GraphQL/DB E2E suites and excludes security specs.
- `npx tsc -p apps/admin-api-service/tsconfig.json --noEmit` passes.
- `npx tsc -p apps/admin-api-service/tsconfig.spec.json --noEmit` passes.
- `npx jest --config apps/admin-api-service/jest.config.ts apps/admin-api-service/src/impersonation/controllers/__tests__/impersonation.controller.spec.ts --runInBand` passes 65 tests.
- `npx jest --config apps/admin-api-service/jest.config.ts apps/admin-api-service/src/tenant/services/provisioning-saga.service.spec.ts --runInBand` passes 11 tests.
- `npm audit --json` from `e2e/` reports 0 vulnerabilities.
