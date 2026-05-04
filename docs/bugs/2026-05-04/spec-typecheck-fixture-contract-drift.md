# Spec Typecheck Fixture Contract Drift

Date: 2026-05-04

## Problem

GitHub Actions `type-check` failed in the baseline-aware spec gate:

- `apps/admin-api-service`: duplicate `extendSession` mock property
- `apps/farm-service`: handler tests missing new production constructor dependencies
- `libs/backend-common`: `RequestContext` fixtures used non-canonical `requestId`
- `apps/messaging-service`: AI Chat E2E expected the word `forbidden` even though the shared `RolesGuard` intentionally returns a generic `Access denied`

## Root Cause

The tests drifted from production contracts:

- Admin impersonation controller tests declared the same service method twice in one mock object.
- Farm batch handler tests did not model newly required domain services: harvest eligibility, tank capacity enforcement, and backdate policy.
- Backend common repository tests used an old request-context field instead of the canonical logging context shape.
- AI Chat E2E asserted on a non-canonical error phrase instead of the GraphQL forbidden code and shared guard message.

## Enterprise Fix

The spec fixtures now align to production contracts instead of weakening TypeScript:

- Admin impersonation service mock has one canonical `extendSession` property.
- Farm handler tests inject explicit service mocks with the behavior the handler contract depends on.
- Backend common tests use `correlationId`, the canonical propagated request correlation field.
- AI Chat E2E now asserts the shared access-denied message plus GraphQL `FORBIDDEN` code.

## Why Not a Patch

No compiler suppressions, `skipLibCheck`, baseline changes, or `as unknown as` gate bypasses were added. The fix updates tests to represent the actual production dependency graph and request context API.

## Validation

- `npx tsc -p apps/admin-api-service/tsconfig.spec.json --noEmit`
- `npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit`
- `npx tsc -p libs/backend-common/tsconfig.spec.json --noEmit`
- `npm run gates:type-check-spec`
