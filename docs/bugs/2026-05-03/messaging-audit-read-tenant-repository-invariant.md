# Messaging Audit Read Tenant Repository Invariant

Date: 2026-05-03

## Problem

The `ComplianceAuditService.getAuditLog()` read path opened a tenant-pinned transaction, but then used `queryRunner.manager.getRepository(ComplianceAuditLog)` directly. The runtime search path was pinned correctly, yet the code violated the repository invariant that tenant business entities must be accessed through the tenant-scoped repository facade.

This was caught by `tests/invariants/no-direct-getrepository-call.spec.ts` in CI. Leaving it as-is would create two classes of risk: future edits could bypass tenant predicates, and the codebase would have inconsistent access patterns for the same tenant business table.

## Enterprise Fix

`getAuditLog()` now uses `tenantManagerRepo(queryRunner.manager, ComplianceAuditLog, filters.tenantId)` inside the existing `runInTenantTransaction()` boundary. The explicit duplicate tenant `where` clauses were removed because the tenant-scoped repository owns the mandatory tenant predicate for query builders.

This keeps the architectural rule singular: tenant business data access goes through tenant-scoped repository helpers or tenant-pinned transaction helpers, never raw `EntityManager.getRepository()` calls.

## Validation

- `npm run invariants:fast`
- `npx tsc -p apps/messaging-service/tsconfig.app.json --noEmit`
- `npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/compliance/services/__tests__/compliance-audit.service.spec.ts --runInBand`
