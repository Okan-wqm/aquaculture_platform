# Package 27: platform-kernel-event-bus-hardening

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [platform-kernel-expert/HIGH-004, platform-kernel-expert/HIGH-005, platform-kernel-expert/HIGH-006]

## Source-Reviews
- /var/aqua-saas/docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Three related defects in the platform event bus kernel: (1) method-level `@SubscribeTo` handlers are registered without `await`, so module init can finish before all subscriptions are active and registration failures are silently dropped; (2) handler failures are caught, logged, and the message is still acknowledged, permanently losing the event for the failed handler; (3) `NatsEventBus.onModuleInit` catches connection failures and continues without the event bus, letting services boot and look healthy while async workflows are disabled. These share the same root cause: the event bus kernel lacks fail-closed semantics.

## Findings
`HIGH-004` (platform-kernel-expert): Method-level event subscriptions are not awaited during bootstrap. File: `platform/libs/event-bus/src/nats/nats.module.ts:156`.

`HIGH-005` (platform-kernel-expert): Handler failures are swallowed and the message is still acknowledged. File: `platform/libs/event-bus/src/nats/nats-event-bus.ts:565,568,576`.

`HIGH-006` (platform-kernel-expert): Event bus startup is fail-open when NATS is unavailable. File: `platform/libs/event-bus/src/nats/nats-event-bus.ts:145,152,157`.

## Affected Files
- /var/aqua-saas/platform/libs/event-bus/src/nats/nats.module.ts
- /var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(event-bus): implement fail-closed semantics for subscriptions, handlers, and startup

The platform event bus had three fail-open behaviors: method-level
subscriptions were registered without await, handler failures were
swallowed while the message was still acked, and NATS unavailability
was treated as a non-fatal startup condition. This makes all
subscription registrations awaited with startup failure on error,
routes handler failures into retry/DLQ instead of acking, and makes
broker availability an explicit readiness dependency.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/27-platform-kernel-event-bus-hardening.md
Closes: docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md#HIGH-004
Closes: docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md#HIGH-005
Closes: docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md#HIGH-006
```

## Test Plan
- Unit test: all subscriptions are awaited during module init.
- Unit test: module init fails if any subscription registration throws.
- Unit test: handler failure causes message NAK, not ACK.
- Unit test: failed messages are routed to dead-letter queue.
- Unit test: NATS unavailability prevents module from reporting ready.
- Integration test: service health check reflects event bus connectivity.

## Verification Command
`npx tsc --noEmit -p platform/libs/event-bus/tsconfig.json && npx jest --testPathPattern="platform/libs/event-bus" --coverage=false`

Dispatch: test-runner

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

