# Messaging Enterprise Tenant Isolation

Status: implemented foundation with fail-closed release gates for the live DB,
NATS, and Prometheus proofs that cannot be replaced by static checks.

## Single Sources Of Truth

- NATS subject construction: `platform/libs/event-bus/src/subjects/tenant-event-subject.ts`.
- Messaging event contracts: `libs/event-contracts/src/messaging-event-registry.ts` and `libs/event-contracts/src/schemas/messaging-events.schema.ts`.
- NATS ACLs: `infrastructure/nats/services.yaml`; `infrastructure/docker/nats/nats.conf` is generated from it.
- Tenant table ownership: `libs/backend-common/src/database/schema-manager.service.ts`.
- AquaMobil query keys: `web/apps/aquamobil/src/utils/tenant-query-keys.ts`.
- Release criticality: `infrastructure/deploy/service-criticality.yaml` and
  the `/health/ready` sweep in `scripts/deploy/droplet-up.sh`.

## Non-Negotiable Contracts

- Durable domain events use `events.{tenantId}.{eventType}`. Two-segment `events.{eventType}` subjects are noncanonical and must be rejected by consumers.
- `messaging_outbox` is source-owned infrastructure. It exists only in `messaging.messaging_outbox`, never in `tenant_<uuid>` schemas.
- The canonical `messaging_outbox.id` type is UUID in the entity, migration, and fresh init SQL.
- Read receipt idempotency and outbox idempotency use the same logical key: tenant, message, messageCreatedAt, and user.
- Message send idempotency is enforced by the non-partitioned `message_idempotency_keys` ledger. The `messages` table is RANGE-partitioned, so PostgreSQL cannot enforce a global unique key on `(tenantId, idempotencyKey)` there without including the partition column.
- Websocket channel membership is tenant-qualified: `channel:{tenantId}:{channelId}` and `user:{tenantId}:{userId}`.
- Push notifications expose only an opaque `notificationRef`; channel/message identifiers are resolved after app authentication.
- `UserDeleted` consumers use `deletedUserId` as the deletion target. Base `userId`, when present, is the actor/requester.
- Raw device tokens have a single active owner enforced by the notification schema and transactional registration flow.

## Migration Semantics

Migrations can declare `@SourceOnlyMigration({ reason })`. The Nest migration runner and the standalone `aqua-db-migrate` runner both record source-only migrations in tenant ledgers as skipped rather than running their DDL against tenant schemas. This keeps tenant ledgers caught up without creating source-owned infrastructure tables in tenant schemas.

The outbox migration `1800200000000-CreateMessagingOutboxTable` is marked source-only and has a post-condition that verifies:

- `messaging.messaging_outbox.id` is UUID.
- No `tenant_<uuid>.messaging_outbox` table exists.

The CI gate `npm run gates:messaging-source-outbox` repeats that proof against a real PostgreSQL database. It fails without a DB URL because regex-only proof is not accepted for this boundary.

## Partition Semantics

`messages` and `message_receipts` are monthly RANGE-partitioned parents in the active TypeORM baseline. `PartitionManagerService` is the runtime SSoT for current and future child partitions, using the shared SQL builders in `apps/messaging-service/src/partition/partition-queries.ts`.

Startup is fail-closed: the partition manager validates that each source and tenant parent is registered in `pg_partitioned_table` with the expected partition key before it creates children. Missing or non-partitioned parents abort boot instead of logging through a broken topology.

Tenant schemas created after app bootstrap must be partition-provisioned immediately. E2E uses the same canonical partition query builders for late-born tenant schemas; production tenant provisioning should call the partition manager hook for the new schema before accepting writes.

Partition child creation has exactly two valid locations:

- migrations may create initial empty child partitions as part of schema definition;
- `apps/messaging-service/src/partition/PartitionManagerService` creates runtime current/future child partitions.

Test fixtures, e2e bootstrap helpers, controllers, and feature services must not issue `CREATE TABLE ... PARTITION OF` directly. This avoids overlapping child ranges and keeps parent/child naming under one runtime owner.

Supported checks:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/messaging-partition-parent-ssot.spec.ts --runInBand
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/single-partition-creator.spec.ts --runInBand
```

## Event And Gateway Semantics

The gateway messaging bridge subscribes to explicit wildcard subjects such as `events.*.MessageSent`, then validates the actual message subject against the payload tenant and event type before broadcasting. Removed channel members are evicted from `channel:{tenantId}:{channelId}` before member-list broadcasts so they do not receive later `ChannelMessageSent`/`MessageSent` traffic through a stale room.

Forwarded-message websocket payloads strip `sourceChannelId` and `sourceMessageId`. Clients that need source details must query them through an authenticated API path instead of receiving them in the broadcast.

`notificationRef` resolution is an authenticated Socket.IO API on the gateway. The gateway sends `request.messaging.resolveNotificationRef` to messaging-service with the authenticated tenant/user. Messaging-service stores refs under tenant+recipient scope, consumes them atomically, verifies active membership and message existence, and returns only the channel/message target required for navigation. Wrong tenant/user refs miss; replayed valid refs fail after first use.

## Privacy And Token Lifecycle

AI conversations subscribe to `UserDeleted` and `GdprAnonymizeRequested` and erase `agent_conversations` for the target user. Notification-service subscribes to `UserDeleted` and revokes device tokens using `deletedUserId`.

Device token registration removes any previous owner for the same raw token in the same transaction that assigns the new owner. A unique index on `notification.device_tokens(token)` is the database backstop for cross-tenant/cross-user reuse.

## Deploy Readiness

`messaging-service` is release-critical in the DO service criticality manifest and is included in the deploy `/health/ready` sweep. A degraded readiness response blocks promotion instead of being treated as a warning.

## Release Evidence

Messaging-affecting releases must attach structured evidence, not free text:

- staged SHA
- source-only outbox DB proof
- migration output
- NATS ACL smoke output
- AquaMobil cache/push contract gate output
- canary Prometheus query output
- rollback manifest
- owner/security signoff

Bypass evidence must include approver, timestamp, reason, scope, and expiry.
