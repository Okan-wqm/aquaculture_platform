# Tenant connection bootstrap tenantId routing gap

Date: 2026-05-02

## Problem

Messaging E2E still wrote unqualified `channels` and `compliance_audit_log`
statements into the `messaging` source schema after entity-level schema pins
were removed.

## Impact

GraphQL/CQRS request paths could preserve `tenantId` while losing the
middleware-derived `schemaName`. In that state, `TenantConnectionBootstrap`
fell back to source-schema search_path and SourceSchemaWriteGuard blocked the
write. Without the guard, this class of bug would place tenant business data
in the source schema.

## Root Cause

The connection bootstrap treated `schemaName` as the only tenant routing input.
`RequestContextMiddleware` already records canonical `tenantId`, but the pool
checkout did not derive `tenant_<id>` from it.

## Fix

`TenantConnectionBootstrap` now resolves tenant schema from:

1. validated `schemaName`
2. canonical UUID `tenantId`

The existing source-schema default remains only for non-request/bootstrap
paths. Unit coverage verifies both the tenantId-derived route and the
explicit-schema precedence rule.

## Verification

Run the new unit spec:

`npx jest libs/backend-common/src/database/__tests__/tenant-connection-bootstrap.service.spec.ts --runInBand`

Messaging E2E should now route unqualified tenant business writes to the tenant
schema even when GraphQL/CQRS async hops do not carry `schemaName`.
