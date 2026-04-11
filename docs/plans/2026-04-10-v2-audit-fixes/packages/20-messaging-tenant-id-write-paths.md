# Package 20: messaging-tenant-id-write-paths

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 18K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: no
Prerequisites: 06-ai-conversation-tenant-isolation
Sprint: 1

## Closing-Findings
Closing-Findings: [messaging-expert/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/messaging-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Core messaging write paths (send-message, forward-message, create-channel, ai-chat-bridge) create entity rows without populating `tenantId`, despite the entities having a `tenantId` column with an index. The outbox worker routes on `event.tenantId`, but the outbox column itself is unset. This means data is persisted without a tenant key and events are published with null tenant subjects, breaking tenant isolation and downstream fanout.

## Findings
`HIGH-002` (messaging-expert): Core messaging write paths drop `tenantId` when creating messages, channels, and outbox rows. Files: `apps/messaging-service/src/message/commands/send-message.handler.ts:160`, `apps/messaging-service/src/message/commands/forward-message.handler.ts:102`, `apps/messaging-service/src/channel/commands/create-channel.handler.ts:199`, `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:346`, `apps/messaging-service/src/outbox/outbox-worker.service.ts:104`.

## Affected Files
- /var/aqua-saas/apps/messaging-service/src/message/commands/send-message.handler.ts
- /var/aqua-saas/apps/messaging-service/src/message/commands/forward-message.handler.ts
- /var/aqua-saas/apps/messaging-service/src/channel/commands/create-channel.handler.ts
- /var/aqua-saas/apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts
- /var/aqua-saas/apps/messaging-service/src/outbox/outbox-worker.service.ts
- /var/aqua-saas/apps/messaging-service/src/message/entities/message.entity.ts
- /var/aqua-saas/apps/messaging-service/src/channel/entities/channel.entity.ts
- /var/aqua-saas/apps/messaging-service/src/outbox/messaging-outbox.entity.ts

## Dependencies
06-ai-conversation-tenant-isolation -- the AI conversation tenant fix must land first because ai-chat-bridge.service.ts is modified in both packages; the tenant isolation fix establishes the tenantId propagation pattern that this package extends to messaging write paths.

## Atomic Commit Plan
```
fix(messaging): thread tenantId into all message, channel, and outbox write paths

Message, channel, and outbox entity creation calls omitted tenantId,
persisting rows without a tenant key and publishing events with null
tenant subjects. This threads tenantId from the request context into
every create() call, adds NOT NULL constraint on the affected columns
via migration, and adds a regression test that fails any write path
producing a row without a tenant key.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/20-messaging-tenant-id-write-paths.md
Closes: docs/reviews/messaging-expert/2026-04-10-full-repo-audit.md#HIGH-002
```

## Test Plan
- Unit test per handler: verify tenantId is set on the created entity.
- Unit test: outbox row has tenantId matching the domain write.
- Migration test: NOT NULL constraint is applied after backfilling existing rows.
- Negative test: creating a message without tenantId fails with constraint violation.
- Integration test: outbox worker routes on non-null tenantId.

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src" --coverage=false`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

