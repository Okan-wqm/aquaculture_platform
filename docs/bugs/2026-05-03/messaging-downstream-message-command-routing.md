# Messaging Downstream Message Command Routing

Date: 2026-05-03

## Problem

Messaging E2E progressed past message creation and exposed downstream message commands still reading from source schema: edit, delete, forward, and mark-read could not find tenant-local messages. Those flows used injected repositories or `DataSource.transaction()` without tenant search-path pinning.

The delete-message unit harness also lacked the production `LegalHoldService` provider and used an invalid tenant fixture, so it no longer represented the handler dependency and tenant-id contract.

## Enterprise Fix

`EditMessageHandler`, `DeleteMessageHandler`, `ForwardMessageHandler`, and `MarkReadHandler` now execute tenant business reads and writes through `runInTenantTransaction()` with `tenantId` predicates. Forwarded attachment copies and read receipts now carry `tenantId` on write.

The delete-message unit test now uses a valid v4 tenant UUID, registers `LegalHoldService`, and verifies the outbox publisher contract directly.

## Validation

- `npx tsc -p apps/messaging-service/tsconfig.app.json --noEmit`
- `npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/message/commands/__tests__/delete-message.handler.spec.ts --runInBand`
- Messaging E2E in GitHub Actions must prove edit/delete/forward/mark-read no longer fail from source-schema message lookups.
