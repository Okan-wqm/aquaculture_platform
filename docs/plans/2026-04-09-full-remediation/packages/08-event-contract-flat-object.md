# Package 08: event-contract-flat-object

## Metadata
Status: PENDING
Estimated Tokens: 8K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes (no prerequisites on 01-07)
Prerequisites: none

## Context
Two tenant event contracts violate the CLAUDE.md flat-object pattern. TenantModulesAssignedEvent nests a `pricing` object and TenantProvisioningFailedEvent serializes steps as a JSON string (`stepsJson`) to work around the flat constraint. Both create schema evolution problems and break downstream consumer type safety.

## Findings

**MEDIUM-001 [data-expert]: TenantModulesAssignedEvent nested pricing violates flat-object contract**
- File: `libs/event-contracts/src/tenant-events.ts` (lines 156-165)
- The event contains a nested `pricing` object. CLAUDE.md requires flat-object pattern for all events extending BaseEvent.

**MEDIUM-002 [data-expert]: TenantProvisioningFailedEvent uses JSON string workaround (stepsJson)**
- File: `libs/event-contracts/src/tenant-events.ts` (lines 88-97)
- The `stepsJson` field serializes an array as a JSON string to work around the flat-object constraint. Creates schema evolution problems and defeats compile-time type checking.

Closing-Findings: [MEDIUM-001, MEDIUM-002]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Affected Files
- `/var/aqua-saas/libs/event-contracts/src/tenant-events.ts`

## Dependencies
None. Event contract changes are upstream of consumers, but flattening these events may require updating consumer deserialization. However, since these events are not yet consumed in production with their current shape, the change is safe without consumer-side updates.

Note: If consumers exist that depend on the nested `pricing` shape or `stepsJson` field, a follow-up package will be needed. Executor should grep for `TenantModulesAssignedEvent` and `TenantProvisioningFailedEvent` usage before committing.

## Atomic Commit Plan
```
fix(event-contracts): flatten TenantModulesAssigned and TenantProvisioningFailed events

Both events violate the flat-object contract required by CLAUDE.md:
- TenantModulesAssignedEvent: replace nested `pricing` object with flat
  fields (e.g., pricingModel, pricingCurrency, pricingAmount)
- TenantProvisioningFailedEvent: replace `stepsJson` string with
  individual step status fields or typed step array using BaseEvent
  extension pattern

BREAKING CHANGE: TenantModulesAssignedEvent.pricing nested object removed;
fields promoted to top level. TenantProvisioningFailedEvent.stepsJson
replaced with typed fields.

Plan: docs/plans/2026-04-09-full-remediation/packages/08-event-contract-flat-object.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-002
```

## Test Plan
- Verify `libs/event-contracts` compiles: `npx tsc --noEmit -p libs/event-contracts/tsconfig.json`
- Grep for consumers of both events; verify no runtime breakage
- Run event-contracts unit tests if present

## Verification Command
`npx tsc --noEmit -p libs/event-contracts/tsconfig.json`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
