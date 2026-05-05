# Farm Service GraphQL Loader Tenant Source

Date: 2026-04-29

## Problem
Farm-service GraphQL context created per-request DataLoaders from the raw `x-tenant-id` header. GraphQL context is built before resolver-level guards complete, so a spoofed header could create DataLoaders for a tenant different from the authenticated request tenant.

## Root Cause
The context factory in `apps/farm-service/src/app.module.ts` trusted a transport header for loader schema selection instead of the authenticated `req.user.tenantId` or normalized `req.tenantId` populated by the auth/tenant middleware and guards.

## Enterprise Fix
DataLoader tenant identity now comes only from authenticated or normalized request context: `req.user.tenantId` first, then `req.tenantId`. Raw `x-tenant-id` is no longer used to create GraphQL loaders.

## Why The Test Was Added
The architecture invariant prevents reintroducing raw header tenant selection in GraphQL loader setup. This protects tenant isolation for loader-backed equipment/batch metrics even when a request includes a spoofed `x-tenant-id` header.

## Verification
Run:

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/graphql-loader-tenant-source.architecture.spec.ts --runInBand
```

## Status
Implemented and verified on 2026-04-29.
