# Trust And Communication Apps Review

**Date:** 2026-05-30  
**Scope:** `apps/auth-service`, `apps/messaging-service`, `apps/notification-service`  
**Mode:** Read-only architecture review synthesized from the trust/communication agent.

## Purpose

Validate that identity, user PII, action tokens, messaging membership, notification delivery, GDPR, NATS subjects, and retention are owned by the right service and are enforced through typed contracts.

## Findings

### TRUST-CRITICAL-001: Notification auth delivery contract is missing on auth side

`notification-service` resolves PII and action URLs through auth internal HTTP routes, but matching auth-service routes were not found. Password reset and invite flows can fail or fall back to unusable URLs.

Evidence:

- `apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:132`
- `apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:161`
- `apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:192`
- `apps/auth-service/src/main.ts:19`
- `apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts:79`
- `apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:334`

Enterprise remediation:

- Auth must expose one official delivery contract: internal HTTP with service identity or NATS request-reply, not both ad hoc.
- The contract must cover user PII, tenant info, and action-token URL resolution.
- Notification must fail closed and produce retryable state when auth contract resolution fails.

### TRUST-CRITICAL-002: Messaging GDPR self-erasure calls undefined auth subject

`messaging-service` requires `request.auth.verifyPassword` before anonymization, but shared auth contracts define only admin subjects.

Evidence:

- `apps/messaging-service/src/gdpr/gdpr.service.ts:248`
- `apps/messaging-service/src/gdpr/gdpr.service.ts:455`
- `libs/event-contracts/src/tenant-commands.ts:158`

Enterprise remediation:

- Add a typed auth-owned password verification command for self-erasure.
- Validate requester identity, tenant membership, MFA/step-up requirements if needed, and rate limiting.
- Add end-to-end GDPR self-erasure tests from messaging through auth.

### TRUST-HIGH-001: `UserDeleted` event contract is violated by auth-service

Auth publishes `UserDeleted` without required fields and adds a non-contract field. Downstream cleanup depends on the canonical contract.

Evidence:

- `apps/auth-service/src/privacy/gdpr-compliance.service.ts:140`
- `libs/event-contracts/src/auth-events.ts:102`

Enterprise remediation:

- Publish the exact shared event shape, including `hardDelete`, `cascadeRequested`, `initiatedBy`, and `cryptoShredKeyId`.
- Add JSON Schema/contract tests at emit site and consumers.
- Verify messaging and notification cleanup consumers against the same event.

### TRUST-HIGH-002: Messaging accepts arbitrary UUIDs as tenant users

Channel creation and add-member paths persist member IDs without auth-backed tenant/user/activity validation.

Evidence:

- `apps/messaging-service/src/channel/commands/create-channel.handler.ts:207`
- `apps/messaging-service/src/channel/commands/add-member.handler.ts:101`

Enterprise remediation:

- Messaging owns channels and memberships, but auth owns user identity and tenant membership.
- Add an auth validation/profile lookup contract and require it for channel create/add-member.
- Add negative tests for ghost users, inactive users, and cross-tenant users.

### TRUST-HIGH-003: AI channel path bypasses privacy consent for content egress

If analysis consent is denied, content still flows to the AI bridge. The bridge can send the current message plus historical context to NATS or tenant custom HTTPS endpoints.

Evidence:

- `apps/messaging-service/src/ai/commands/analyze-message.handler.ts:52`
- `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:160`
- `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:295`
- `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:442`

Enterprise remediation:

- Consent denial must block content egress, not merely alter metadata.
- Define context minimization limits, custom endpoint allowlist/governance, tenant audit log, and data residency policy.
- Add tests proving denied consent sends no message content outside messaging.

### TRUST-HIGH-004: Notification retry SQL is likely invalid PostgreSQL

The retry path uses `UPDATE ... ORDER BY ... LIMIT 100 RETURNING *`, which PostgreSQL does not support directly.

Evidence:

- `apps/notification-service/src/notification/services/notification-dispatcher.service.ts:700`

Enterprise remediation:

- Use a CTE/subquery with row locking to claim retry work deterministically.
- Include idempotency and concurrency tests for multiple dispatch workers.

### TRUST-MEDIUM-001: NATS subject shape drift can miss tenant provisioning events

The event bus documents `events.{tenantId}.{eventType}`, while messaging listens on a two-segment tenant provisioning pattern.

Evidence:

- `platform/libs/event-bus/src/interfaces/event-bus.interface.ts:105`
- `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:507`

Enterprise remediation:

- Route all subject names through shared constants/helpers.
- Add subject parity tests between emitters and consumers.

### TRUST-MEDIUM-002: Tenant-scoped background jobs use unscoped raw SQL

Messaging embedding cron reads and updates `messages` through raw `dataSource.query` without explicit tenant-loop/search-path handling.

Evidence:

- `apps/messaging-service/src/ai/services/embedding.service.ts:98`
- `apps/messaging-service/src/ai/services/embedding.service.ts:181`

Enterprise remediation:

- Background jobs must enumerate tenant schemas or use an explicit source-schema read model.
- Add tests proving each tenant is processed and no wrong-schema query occurs.

### TRUST-MEDIUM-003: Channel mutation rate limits are not applied

Rate limit rules define `createChannel`, but the channel resolver is not decorated with the interceptor.

Evidence:

- `apps/messaging-service/src/shared/interceptors/messaging-rate-limit.interceptor.ts:92`
- `apps/messaging-service/src/message/resolvers/message.resolver.ts:187`
- `apps/messaging-service/src/channel/resolvers/channel.resolver.ts:157`

Enterprise remediation:

- Apply rate limits at the resolver/module boundary, with tests for create/add-member abuse.

### TRUST-MEDIUM-004: PII minimization is inconsistent

JWTs are non-PII, but auth logs registration emails, auth support messaging stores names/snippets, and notification logs persist recipient/content/metadata.

Evidence:

- `apps/auth-service/src/modules/authentication/services/token.service.ts:21`
- `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:104`
- `apps/auth-service/src/modules/messaging/services/messaging.service.ts:250`
- `apps/auth-service/src/modules/messaging/services/messaging.service.ts:274`
- `apps/notification-service/src/notification/entities/notification-log.entity.ts:57`
- `apps/notification-service/src/notification/services/notification-retention.service.ts:16`

Enterprise remediation:

- Define retention and masking rules per PII sink.
- Add tests/gates for JWT/event/log PII redaction.

## Recommended Fix Order

1. Add auth internal delivery and password verification contracts.
2. Fix `UserDeleted` contract and downstream cleanup.
3. Add auth-backed user validation for messaging memberships.
4. Lock down AI content egress consent and custom endpoints.
5. Normalize NATS subjects through helpers.
6. Fix notification retry SQL, tenant-scoped embedding jobs, and channel rate limits.
7. Document and enforce PII retention/masking.
