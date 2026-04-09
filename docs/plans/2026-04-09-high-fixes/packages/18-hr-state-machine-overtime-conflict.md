# Package 18: hr-state-machine-overtime-conflict

## Metadata
Status: PENDING
Estimated Tokens: 30K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Closing-Findings: [HR-HIGH-007, HR-HIGH-008, HR-HIGH-009, HR-HIGH-010, HR-HIGH-011, HR-HIGH-012]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
HR-service architectural and business logic HIGHs: (1) leave accrual is O(N^2) per employee, (2) no state machine for leave/HR workflows (ad-hoc status transitions), (3) overtime 45h weekly threshold hardcoded (varies by jurisdiction), (4) conflict detection is advisory-only (concurrent approvals not prevented), (5) reopening closed leave request destroys audit trail (original close reason overwritten), (6) cert expiry does not emit NATS events.

## Findings

**HR-HIGH-007** (hr-expert, HIGH)
File: apps/hr-service/src/leave/services/accrual.service.ts
Leave accrual calculation iterates all leave entries for each employee per period. O(N^2) for large teams. Should use aggregate query.

**HR-HIGH-008** (hr-expert, HIGH)
No formal state machine for leave request lifecycle. Status transitions are ad-hoc if/else chains. Invalid transitions (e.g., APPROVED -> PENDING) are not prevented.

**HR-HIGH-009** (hr-expert, HIGH)
File: apps/hr-service/src/payroll/services/overtime.service.ts
Weekly overtime threshold hardcoded at 45 hours. Turkish labor law requires 45h but other jurisdictions (EU Working Time Directive = 48h, US FLSA = 40h) differ. Multi-country tenants get wrong overtime calculations.

**HR-HIGH-010** (hr-expert, HIGH)
Conflict detection for concurrent leave approvals is advisory-only. Two managers can approve overlapping leave requests simultaneously. No pessimistic lock or optimistic version check.

**HR-HIGH-011** (hr-expert, HIGH)
Reopening a closed/cancelled leave request overwrites the original close reason and close timestamp. The audit trail for why the request was originally closed is destroyed.

**HR-HIGH-012** (hr-expert, HIGH)
Certificate/license expiry tracking does not emit NATS events. Other services (notification-service for reminders, compliance dashboard) have no way to know when certifications expire.

## Affected Files
- apps/hr-service/src/leave/services/accrual.service.ts
- apps/hr-service/src/leave/services/leave-request.service.ts
- apps/hr-service/src/payroll/services/overtime.service.ts
- apps/hr-service/src/certification/services/certification.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(hr): add leave state machine, configurable overtime threshold, pessimistic conflict detection

Leave accrual O(N^2), no state machine, hardcoded 45h overtime, advisory-only
conflict detection, reopen destroys audit trail, cert expiry has no NATS events.

Replace accrual iteration with aggregate query. Implement finite state machine
for leave lifecycle with guarded transitions. Make overtime threshold
configurable per tenant jurisdiction. Add pessimistic_write lock to leave
approval. Preserve original close reason on reopen (append, not overwrite).
Emit CertificationExpiring NATS event from certification service.

Plan: docs/plans/2026-04-09-high-fixes/packages/18-hr-state-machine-overtime-conflict.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-008
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-009
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-010
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-011
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-012
```

## Test Plan
- Unit test: accrual service uses SQL aggregate (performance benchmark)
- Unit test: state machine rejects APPROVED -> PENDING transition
- Unit test: state machine allows PENDING -> APPROVED
- Unit test: overtime calculation uses tenant-configured threshold
- Unit test: concurrent leave approval second attempt fails with lock error
- Unit test: reopen preserves original close reason in audit history
- Unit test: cert expiry emits CertificationExpiring event

## Verification Command
`npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src/(leave|payroll|certification)" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
