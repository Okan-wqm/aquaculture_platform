# Package 16: security-events-flatten

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 14K
Priority: HIGH
Security-Sensitive: no
Parallelizable: no
Prerequisites: 03-event-bus-pii-removal
Sprint: 1

## Closing-Findings
Closing-Findings: [data-expert/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/data-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Security events violate the flat-event contract by embedding a nested `details: Record<string, unknown>` bag, and collapse all subtypes behind a generic `SecurityEvent` discriminator. This forces consumers to inspect a second discriminator and prevents stable schema-based routing and validation.

## Findings
`HIGH-002` (data-expert): Security events violate the flat-event contract by embedding a nested `details` bag. Files: `libs/event-contracts/src/security/security-events.ts:28-36,43-50,57-63,168-174`. The `eventType` is always `SecurityEvent`, which weakens routing/validation guarantees.

## Affected Files
- /var/aqua-saas/libs/event-contracts/src/security/security-events.ts

## Dependencies
03-event-bus-pii-removal -- both packages modify `libs/event-contracts`. The PII removal (package 03) must land first as it changes the base event contract and auth events. Security event flattening can then be applied on top without conflicts.

## Atomic Commit Plan
```
refactor(event-contracts): flatten security events into typed top-level fields

Security events embedded a nested details: Record<string, unknown> bag
and collapsed all subtypes behind a generic SecurityEvent discriminator,
violating the flat-event contract. This splits security subtypes into
separate event contracts (LoginAttemptFailed, PermissionDenied, etc.)
with explicit top-level fields and dedicated eventType discriminators,
enabling stable schema-based routing and validation.

BREAKING CHANGE: SecurityEvent generic type is replaced by specific
event types. Consumers must update subscriptions to the new event names.

data-expert review required

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/16-security-events-flatten.md
Closes: docs/reviews/data-expert/2026-04-10-full-repo-audit.md#HIGH-002
```

## Test Plan
- Unit test: each security event type has flat top-level fields, no nested `details`.
- Unit test: each security event has a unique `eventType` discriminator.
- Type test: `Record<string, unknown>` field on security events fails compilation.
- Integration test: consumers can route by specific event type.

## Verification Command
`npx tsc --noEmit -p libs/event-contracts/tsconfig.json`

Dispatch: test-runner

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

