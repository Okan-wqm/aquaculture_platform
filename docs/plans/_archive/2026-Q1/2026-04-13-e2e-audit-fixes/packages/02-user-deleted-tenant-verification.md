# Package 02: user-deleted-tenant-verification

## Metadata
Status: PENDING
Estimated Tokens: ~11K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (with 01, 03)
Prerequisites: none

## Source Reviews
- docs/test-audits/tenant-isolation-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [tenant-isolation-auditor/CRITICAL-002]

## Context

**IMPORTANT (verified by senior engineer — planner missed this):**

Same `deriveSubject()` issue as Package 01. Auth-service publishes `UserDeleted` via `this.eventBus.publish()` at `apps/auth-service/src/privacy/gdpr-compliance.service.ts:120-125`. The `NatsEventBus.deriveSubject()` produces subject `events.{tenantId}.UserDeleted`. However, the messaging-service handler uses `@EventPattern('events.UserDeleted')` (no tenant segment) at line 212. **These subjects likely do not match**, meaning the GDPR cleanup cascade may not be reaching messaging-service at all.

Additionally, even if the events do arrive (via some NATS stream configuration), the handler trusts `data.tenantId` from the payload and uses it to set PostgreSQL `search_path` for destructive operations. UUID validation exists (prevents SQL injection) but does NOT prevent cross-tenant writes.

**The fix must address both issues:**
1. Fix the `@EventPattern` to match the tenant-scoped subject: `events.*.UserDeleted`
2. Before executing destructive operations, verify that the userId has actual presence (messages or channel memberships) in the claimed tenant schema — if the user has zero footprint, skip the cascade gracefully (the user may never have used messaging in that tenant)
3. Log SECURITY warning if tenantId from payload doesn't match the subject-derived tenantId

## Findings
tenant-isolation-auditor CRITICAL-002: UserDeleted cascade can execute destructive writes in wrong tenant schema.
- File: `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts` lines 212-279
- The `@EventPattern('events.UserDeleted')` subject does not match the publisher's tenant-scoped subject `events.{tenantId}.UserDeleted`. Handler takes `data.tenantId` from payload and sets `search_path` accordingly. UUID validation exists (prevents SQL injection) but does NOT prevent cross-tenant writes.
- Severity: CRITICAL
- Gap class: tenant-gap, access-gap, write-gap

## Affected Files
- apps/messaging-service/src/event-handlers/messaging-nats.handler.ts (primary — modify @EventPattern and handleUserDeleted)
- apps/auth-service/src/privacy/gdpr-compliance.service.ts (read-only reference — verify publish uses eventBus.publish() → deriveSubject() path)

## Dependencies
Prerequisites: none
This package touches only the messaging-service NATS handler. No shared lib changes. Should be implemented in parallel with Package 01 (both fix the same subject-mismatch pattern).

## Atomic Commit Plan
```
security(messaging): fix UserDeleted subject mismatch and add tenant verification

Two issues in the UserDeleted NATS handler:

1. @EventPattern('events.UserDeleted') does not match the publisher's
   tenant-scoped subject `events.{tenantId}.UserDeleted` (from
   NatsEventBus.deriveSubject()). Fix: change to
   @EventPattern('events.*.UserDeleted') to receive tenant-scoped events.

2. Handler trusts data.tenantId from payload for search_path. Fix: before
   executing destructive operations, verify the userId has actual presence
   (messages or memberships) in the claimed tenant schema. If zero
   footprint, skip gracefully. Log SECURITY warning on subject/payload
   tenantId mismatch.

Addresses: tenant-isolation-auditor/CRITICAL-002

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/02-user-deleted-tenant-verification.md
Closes: docs/test-audits/tenant-isolation-auditor/2026-04-11-full-platform-e2e.md#CRITICAL-002
```

## Test Plan
- Unit test: publish to `events.{tenantId}.UserDeleted` — verify the handler receives the event with the new @EventPattern
- Unit test: emit UserDeleted event with tenantId where userId has zero footprint (no messages, no memberships). Assert handler exits gracefully without error or destructive queries.
- Unit test: emit UserDeleted event with correct tenantId where user has messages. Assert the full cascade executes (anonymization, membership cleanup, reaction/receipt deletion).
- Unit test: emit UserDeleted with mismatched subject-tenantId vs payload-tenantId. Assert SECURITY warning is logged and event is dropped.
- Existing legal hold preservation logic must continue to work.

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/event-handlers" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
