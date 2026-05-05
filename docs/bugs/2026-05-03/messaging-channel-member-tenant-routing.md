# Messaging Channel Member Tenant Routing

Date: 2026-05-03

## Problem

Messaging E2E exposed `ChannelMember` inserts with `tenantId` omitted during `addChannelMember`. The handler opened a raw `QueryRunner` transaction, did not pin the transaction-local search path, did not include `tenantId` in membership lookups, and created new membership rows without `tenantId`.

The same E2E run also exposed DIRECT-channel idempotency reads happening outside the tenant-pinned transaction. That allowed the existing DM lookup to miss the tenant-local row and attempt a duplicate insert.

The targeted unit test for `AddMemberHandler` also used a non-UUID tenant fixture. That fixture no longer represented the production tenant contract once the handler moved onto `runInTenantTransaction()`, which correctly rejects non-v4 tenant identifiers before opening a database transaction.

## Enterprise Fix

`AddMemberHandler` now runs through `runInTenantTransaction()`, pins the tenant schema before any read/write, includes `tenantId` in channel and membership predicates, and writes `tenantId` onto new or reactivated `ChannelMember` rows.

`CreateChannelHandler` now performs the DIRECT existing-DM lookup inside the same tenant-pinned transaction that creates the channel. The idempotency read and create path therefore use the same physical tenant schema and cannot drift between source and tenant schemas.

The unit fixture now uses a valid v4 tenant UUID so tests exercise the real tenant schema derivation path instead of relying on invalid synthetic tenant ids.

## Validation

- `npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/channel/commands/__tests__/add-member.handler.spec.ts --runInBand`
- `npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/channel/commands/__tests__/create-channel.handler.spec.ts --runInBand`
- Messaging E2E in GitHub Actions must prove channel creation, member add/remove, send-message membership checks, and tenant-isolation specs no longer cascade from missing membership rows.
