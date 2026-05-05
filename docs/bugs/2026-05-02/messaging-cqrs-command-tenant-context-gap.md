# Messaging CQRS command tenant context gap

Date: 2026-05-02

## Problem

Messaging E2E still failed on `createChannel` after unqualified entity routing
and tenantId-derived pool routing were added.

## Impact

Command handlers that open their own QueryRunner can acquire a database
connection outside the HTTP middleware AsyncLocalStorage chain. In that state,
unqualified tenant business writes resolve against the source schema and are
correctly blocked by SourceSchemaWriteGuard.

## Root Cause

`CreateChannelHandler` received `tenantId` in the command payload but did not
establish a tenant AsyncLocalStorage frame before opening QueryRunner
transactions.

## Fix

`CreateChannelHandler.execute()` now wraps the command body with
`withTenantContext(command.tenantId, ...)` before any repository lookup or
QueryRunner transaction starts. This makes the command tenant context explicit
at the CQRS boundary and independent of GraphQL middleware propagation.

The compliance audit interceptor also writes audit entries inside
`withTenantContext(tenantId, ...)` because its fire-and-forget observable path
can run after the original request context is no longer available.

## Verification

`npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/channel/commands/__tests__/create-channel.handler.spec.ts --runInBand`

passed with the tenant-context wrapper active.
