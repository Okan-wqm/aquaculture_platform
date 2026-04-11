# Package 03: event-bus-pii-removal

## Metadata
Status: PENDING
Estimated Tokens: 20K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [data-expert/CRITICAL-001, security-reviewer/CRITICAL-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/data-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
`PasswordResetRequestedEvent` carries email and the full reset URL. `UserInvitedEvent` carries email, firstName, lastName, tenantName, and an actionUrl with embedded tokens. `BaseEvent.cryptoShredKeyId` exists but is optional and never set by any producer. These payloads are immutable once published, making the event store a permanent PII and credential archive. This is both a GDPR compliance violation and a security breach vector.

## Findings
`CRITICAL-001` (data-expert): PII and secret-bearing reset URLs are published on the immutable event bus without any implemented crypto-shred or indirection path. Files: `libs/event-contracts/src/auth-events.ts:31-52`, `libs/event-contracts/src/notification-events.ts:6-23`, `libs/event-contracts/src/base-event.ts:103-115`.

`CRITICAL-002` (security-reviewer): PII and reset URLs are published on the immutable event bus with no enforced crypto-shred path. Files: `libs/event-contracts/src/auth-events.ts:39,46,49`, `libs/event-contracts/src/notification-events.ts:6,20`, `apps/auth-service/src/modules/tenant/services/tenant.service.ts:288,297`, `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:412,421`.

## Affected Files
- /var/aqua-saas/libs/event-contracts/src/auth-events.ts
- /var/aqua-saas/libs/event-contracts/src/notification-events.ts
- /var/aqua-saas/libs/event-contracts/src/base-event.ts
- /var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant.service.ts
- /var/aqua-saas/apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts
- /var/aqua-saas/apps/notification-service/src/notification/event-handlers/ (consumers)

## Dependencies
None.

## Atomic Commit Plan
```
security(event-contracts): remove PII and secret URLs from event payloads

PasswordResetRequestedEvent and UserInvitedEvent carried raw email,
name, and full reset/invite URLs on the immutable event bus, creating a
permanent PII and credential archive. This replaces direct PII fields
with opaque lookup references (userId, actionTokenId) and moves
sensitive data resolution to a purpose-built secure store at delivery
time. Makes cryptoShredKeyId mandatory for events that still carry
any personally-identifiable metadata.

BREAKING CHANGE: PasswordResetRequestedEvent and UserInvitedEvent no
longer carry email, firstName, lastName, or actionUrl fields. Consumers
must resolve these via the secure lookup service.

data-expert review required

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/03-event-bus-pii-removal.md
Closes: docs/reviews/data-expert/2026-04-10-full-repo-audit.md#CRITICAL-001
Closes: docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md#CRITICAL-002
```

## Test Plan
- Verify event contract types no longer include email, name, or URL fields.
- Unit test: producer emits event with opaque references instead of PII.
- Unit test: notification consumer resolves PII from secure store.
- Negative test: publishing an event with raw PII fields fails TypeScript compilation.
- Integration test: password reset flow works end-to-end with the new indirection.

## Verification Command
`npx tsc --noEmit -p libs/event-contracts/tsconfig.json && npx tsc --noEmit -p apps/auth-service/tsconfig.json && npx jest --testPathPattern="apps/auth-service/src" --coverage=false`

Dispatch: security-reviewer
Dispatch: test-runner

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

