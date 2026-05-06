# Messaging Channel Message Read Write Routing

Date: 2026-05-03

## Problem

After the channel-member insert issue was fixed, Messaging E2E progressed to the next tenant-routing class. Channel single reads and channel metadata commands were still using repository or transaction paths that did not pin the tenant schema. Message sending also used `DataSource.transaction()` for `messages`, which let the source write guard correctly block writes to `messaging.messages_2026_05`.

At the GraphQL boundary, `MessageResolver.validateChannelMembership()` read `ChannelMember` through an injected repository without tenant schema pinning. That caused valid users to be rejected as "not a member" even when channel membership existed in the tenant schema.

## Enterprise Fix

Channel single-read, channel update, and channel archive flows now use `runInTenantTransaction()` and include `tenantId` in predicates. `SendMessageHandler` now reads idempotent existing messages and writes messages, attachments, and outbox events inside a tenant-pinned transaction, with attachment rows carrying `tenantId`.

The resolver membership guard now accepts `tenantId` explicitly and performs the membership lookup through `runInTenantTransaction()`. GraphQL authorization and command execution therefore share the same physical tenant schema contract.

## Validation

- `npx tsc -p apps/messaging-service/tsconfig.app.json --noEmit`
- Targeted channel/message unit tests must cover tenant-pinned transaction calls.
- Messaging E2E in GitHub Actions must prove channel get/update/archive, sendMessage, content sanitization, media upload, compliance, GDPR, and tenant isolation no longer fail from source-schema reads/writes.
