# Package 26: messaging-tenant-isolation-nats

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 28K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [MSG-HIGH-046, MSG-HIGH-047, MSG-HIGH-048, MSG-HIGH-051, MSG-HIGH-052]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Messaging service tenant isolation and NATS subject HIGHs: (1) TypeORM synchronize:true in production (schema drift risk), (2) conversation queries have no tenant check, (3) custom system prompt injection for AI, (4) NATS subject pattern does not include tenantId (cross-tenant message routing), (5) channel guard has no Redis cache (performance + staleness).

## Findings

**MSG-HIGH-046** (messaging-expert, HIGH)
TypeORM synchronize:true in messaging service configuration. Auto-sync modifies database schema without migration, causing drift between environments and potential data loss on entity changes.

**MSG-HIGH-047** (messaging-expert, HIGH)
Conversation queries have no tenant check. Direct conversation lookups by ID do not include tenantId in WHERE clause. Any authenticated user can access conversations from other tenants.

**MSG-HIGH-048** (messaging-expert, HIGH)
Custom system prompt field allows injection. Same as MSG-HIGH-036 but specifically in the conversation-level AI context configuration.

**MSG-HIGH-051** (messaging-expert, HIGH)
NATS subject pattern for messaging events does not include tenantId. All tenants' messaging events share the same NATS subject, preventing per-tenant filtering and enabling cross-tenant event subscription.

**MSG-HIGH-052** (messaging-expert, HIGH)
Channel authorization guard queries database on every request with no Redis cache. High-frequency chat operations cause excessive DB load. Stale permission state possible during guard DB query latency.

## Affected Files
- apps/messaging-service/src/app.module.ts (synchronize config)
- apps/messaging-service/src/messaging/services/conversation.service.ts
- apps/messaging-service/src/ai/services/ai-context.service.ts
- apps/messaging-service/src/nats/ (subject patterns)
- apps/messaging-service/src/guards/channel-authorization.guard.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(messaging): disable synchronize, add conversation tenant check, fix NATS subjects, cache guard

TypeORM synchronize:true causes schema drift. Conversation queries lack
tenantId. NATS subjects missing tenantId segment. Channel guard has no cache.

Set synchronize:false. Add tenantId to all conversation queries. Include
tenantId in NATS subject pattern (messaging.{tenantId}.{eventType}). Add
Redis cache to channel authorization guard with 60s TTL.

Plan: docs/plans/2026-04-09-high-fixes/packages/26-messaging-tenant-isolation-nats.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-046
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-047
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-048
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-051
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-052
```

## Test Plan
- Unit test: synchronize is false in all environments
- Unit test: conversation findById includes tenantId in WHERE
- Unit test: NATS subject includes tenantId segment
- Unit test: channel guard uses Redis cache on second call
- Unit test: cache invalidation on permission change

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/(messaging|nats|guards)" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
