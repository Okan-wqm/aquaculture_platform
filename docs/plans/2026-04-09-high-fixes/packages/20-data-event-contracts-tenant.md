# Package 20: data-event-contracts-tenant

## Metadata
Status: PENDING
Estimated Tokens: 25K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: no
Prerequisites: none
Closing-Findings: [DATA-HIGH-002, DATA-HIGH-003, DATA-HIGH-004, DATA-HIGH-005, DATA-HIGH-012, DATA-HIGH-016, DATA-HIGH-020]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
  - docs/reviews/data-expert/2026-04-06-nestjs-di-reflect-metadata-docker.md

## Context
Data layer HIGHs that affect cross-service contracts and event integrity: (1) IEvent.tenantId is optional (allows tenant-less events), (2) PII in events with no crypto-shred support, (3) nested objects violate flat-object event contract pattern, (4) Record<string,unknown> features field allows arbitrary payloads, (5) as any in TenantConnectionBootstrap, (6) NATS consumer does not validate tenantId, (7) messaging_outbox table misclassified as messaging when it is platform infrastructure.

## Findings

**DATA-HIGH-002** (data-expert, HIGH)
File: libs/event-contracts/src/base-event.ts
IEvent.tenantId is declared optional (?). Allows events to be published without tenant context. Every consumer must handle undefined tenantId as a special case.

**DATA-HIGH-003** (data-expert, HIGH)
PII fields (employeeName, email, nationalId) embedded directly in event payloads. No crypto-shred support -- GDPR erasure requires replaying and redacting all events containing PII.

**DATA-HIGH-004** (data-expert, HIGH)
File: libs/event-contracts/src/tenant-events.ts
Nested objects in TenantModulesAssignedEvent (pricing object) and stepsJson string workaround violate CLAUDE.md flat-object pattern. Schema evolution is blocked.

**DATA-HIGH-005** (data-expert, HIGH)
Record<string,unknown> used as features field type. Accepts any JSON structure without compile-time or runtime validation. Downstream consumers cannot rely on field presence.

**DATA-HIGH-012** (data-expert, HIGH)
File: libs/backend-common/src/bootstrap/tenant-connection.bootstrap.ts
as any cast in TenantConnectionBootstrap. Bypasses TypeScript type checking in multi-tenant connection setup -- tenant isolation critical path.

**DATA-HIGH-016** (data-expert, HIGH)
NATS consumers do not validate that the tenantId in the event payload matches the NATS subject's tenant segment. Mismatched tenantId causes cross-tenant data routing.

**DATA-HIGH-020** (data-expert, HIGH)
messaging_outbox table classified under messaging service but is platform infrastructure used by multiple services. Misclassification prevents proper shared-lib migration.

## Affected Files
- libs/event-contracts/src/base-event.ts
- libs/event-contracts/src/tenant-events.ts
- libs/backend-common/src/bootstrap/tenant-connection.bootstrap.ts
- libs/backend-common/src/nats/ (consumer validation)

## Dependencies
DATA-HIGH-002 (tenantId required) is a BREAKING CHANGE for all event publishers. Must be coordinated with all services. This package should be committed BEFORE any service-specific packages that depend on event contract types.

## Atomic Commit Plan
```
fix(event-contracts): make tenantId required, flatten nested events, add NATS tenant validation

IEvent.tenantId is optional allowing tenant-less events. Nested objects in
TenantModulesAssignedEvent violate flat-object pattern. NATS consumers do not
validate tenantId matches subject. as any in TenantConnectionBootstrap.

Make IEvent.tenantId required (non-optional). Flatten nested pricing into
top-level fields. Replace stepsJson string with typed flat fields. Add
subject-vs-payload tenantId cross-check in NATS consumer base class.
Remove as any from TenantConnectionBootstrap with proper typing.

BREAKING CHANGE: IEvent.tenantId is now required. All event publishers must
supply tenantId. TenantModulesAssignedEvent shape changes (pricing flattened).

data-expert review required

Plan: docs/plans/2026-04-09-high-fixes/packages/20-data-event-contracts-tenant.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-HIGH-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-HIGH-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-HIGH-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-HIGH-005
Closes: docs/reviews/data-expert/2026-04-06-nestjs-di-reflect-metadata-docker.md#DATA-HIGH-012
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-HIGH-016
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-HIGH-020
```

## Test Plan
- Unit test: event construction without tenantId fails at compile time
- Unit test: TenantModulesAssignedEvent has no nested objects
- Unit test: NATS consumer rejects event where payload.tenantId != subject tenant
- Unit test: TenantConnectionBootstrap compiles without as any
- Unit test: all existing event tests pass with required tenantId

## Verification Command
`npx tsc --noEmit -p libs/event-contracts/tsconfig.json && npx tsc --noEmit -p libs/backend-common/tsconfig.json && npx jest --testPathPattern="libs/(event-contracts|backend-common)" --coverage=false`
[Dispatch: test-runner]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
