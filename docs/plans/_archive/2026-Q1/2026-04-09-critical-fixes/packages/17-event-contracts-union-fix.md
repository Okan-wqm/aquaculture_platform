# Package 17: event-contracts-union-fix

## Metadata
Status: PENDING
Estimated Tokens: 4K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [DATA-CRITICAL-001]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
The `AnyPlatformEvent` union type in the event contracts barrel export is missing `SecurityEvent`. This means any generic event handler typed against `AnyPlatformEvent` (event store ingestion, audit logging, dead-letter processing) silently drops security events or fails at runtime with a type mismatch. Security events (login attempts, permission changes, impersonation) not reaching the event store creates a critical audit gap.

## Findings
- **DATA-CRITICAL-001**: AnyPlatformEvent union missing SecurityEvent
  - File: `libs/event-contracts/src/index.ts` (~2.1K chars)
  - The union type does not include SecurityEvent in its member list
  - Root cause: SecurityEvent was added after the union type was created

## Affected Files
- `/var/aqua-saas/libs/event-contracts/src/index.ts` (~2.1K chars)

## Dependencies
None. This is a shared library change.

## Atomic Commit Plan
```
fix(event-contracts): add SecurityEvent to AnyPlatformEvent union

Add SecurityEvent (and any other missing event types) to the
AnyPlatformEvent discriminated union. This ensures generic event
handlers process security events correctly.

Closes: docs/reviews/2026-04-09-critical-fixes#DATA-CRITICAL-001
Plan: docs/plans/2026-04-09-critical-fixes/packages/17-event-contracts-union-fix.md
```

## Test Plan
- Unit test: AnyPlatformEvent type accepts SecurityEvent instances
- Unit test: exhaustive switch/case over AnyPlatformEvent covers SecurityEvent
- Compile check: no type errors in consumers of AnyPlatformEvent

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p libs/event-contracts/tsconfig.json
```
Dispatch: test-runner

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
