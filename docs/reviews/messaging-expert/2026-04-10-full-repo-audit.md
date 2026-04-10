# Messaging Expert Review
Date: 2026-04-10
Scope: `apps/messaging-service/**`, `apps/ai-service/**`, and closely related shared contracts/libs

## Findings

### CRITICAL-001: AI conversation sessions are readable and writable across tenants/users by conversation UUID
[`apps/ai-service/src/conversation/conversation.service.ts:31`](/var/aqua-saas/apps/ai-service/src/conversation/conversation.service.ts#L31) exposes `getById(id)` with no tenant or owner predicate, and [`apps/ai-service/src/conversation/conversation.service.ts:31`](/var/aqua-saas/apps/ai-service/src/conversation/conversation.service.ts#L31) also updates `agent_conversations` by `id` only in `addMessage`, `updateTokenCount`, and `deactivate`. [`apps/ai-service/src/agent/agent-runner.service.ts:99`](/var/aqua-saas/apps/ai-service/src/agent/agent-runner.service.ts#L99) accepts a caller-supplied `conversationId`, loads that record, then appends both user and assistant turns before any ownership check. A user who knows or obtains another conversation UUID can therefore hydrate another user's history into the prompt and mutate that conversation, which is a tenant-boundary confidentiality breach and a prompt-injection vector.

Remediation: require `tenantId` plus `userId` on every conversation lookup and update, enforce it in the SQL predicate, and reject any `conversationId` not owned by the current tenant/user before history is loaded.

### HIGH-002: Core messaging write paths drop `tenantId` when creating messages, channels, and outbox rows
The schema contracts require tenant scoping on the core entities: [`apps/messaging-service/src/message/entities/message.entity.ts:35`](/var/aqua-saas/apps/messaging-service/src/message/entities/message.entity.ts#L35) and [`apps/messaging-service/src/channel/entities/channel.entity.ts:36`](/var/aqua-saas/apps/messaging-service/src/channel/entities/channel.entity.ts#L36) both index `tenantId`, and [`apps/messaging-service/src/outbox/messaging-outbox.entity.ts:24`](/var/aqua-saas/apps/messaging-service/src/outbox/messaging-outbox.entity.ts#L24) requires `tenantId` for outbox routing. The actual write paths never populate that field: [`apps/messaging-service/src/message/commands/send-message.handler.ts:160`](/var/aqua-saas/apps/messaging-service/src/message/commands/send-message.handler.ts#L160), [`apps/messaging-service/src/message/commands/forward-message.handler.ts:102`](/var/aqua-saas/apps/messaging-service/src/message/commands/forward-message.handler.ts#L102), [`apps/messaging-service/src/channel/commands/create-channel.handler.ts:199`](/var/aqua-saas/apps/messaging-service/src/channel/commands/create-channel.handler.ts#L199), and [`apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:346`](/var/aqua-saas/apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts#L346) all create rows without `tenantId`. The same handlers then create outbox rows whose payload contains `tenantId`, but the outbox column itself is still unset, while [`apps/messaging-service/src/outbox/outbox-worker.service.ts:104`](/var/aqua-saas/apps/messaging-service/src/outbox/outbox-worker.service.ts#L104) routes on `event.tenantId`. That combination means new data is persisted without a tenant key and published with an undefined/null tenant subject, which breaks tenant isolation and downstream fanout.

Remediation: thread `tenantId` into every `create()` call for tenant-scoped entities, backfill and enforce `NOT NULL` on the affected columns, and add a regression test that fails any write path producing a row without a tenant key.

## Cross-Domain Dependencies

- `multi-tenant-saas-expert`: tenant-scoped write invariants and tenant-boundary enforcement.
- `security-reviewer`: confirm the conversation ownership model once the tenant predicate is added, since this is a user-facing trust boundary.

## Verification

Static review only. I did not run the test suite.
