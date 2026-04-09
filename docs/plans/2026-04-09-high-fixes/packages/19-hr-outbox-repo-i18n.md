# Package 19: hr-outbox-repo-i18n

## Metadata
Status: PENDING
Estimated Tokens: 25K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [HR-HIGH-013, HR-HIGH-014, HR-HIGH-015, HR-HIGH-016, HR-HIGH-017, HR-HIGH-018]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Remaining HR-service HIGHs: (1) cert handler not transactional (partial updates on failure), (2) injected repo bypasses search_path (tenant isolation), (3) fire-and-forget events with no outbox, (4) CancelLeave missing .catch (floating promise), (5) national ID unmasked in frontend display, (6) hardcoded English strings throughout HR module.

## Findings

**HR-HIGH-013** (hr-expert, HIGH)
File: apps/hr-service/src/certification/handlers/certification.handler.ts
Certification handler operations (create, update, delete) are not transactional. Multiple entity saves in sequence -- partial update on failure leaves inconsistent state.

**HR-HIGH-014** (hr-expert, HIGH)
File: apps/hr-service/src/hr/handlers/*.ts
Injected repository instances bypass search_path tenant isolation. Same pattern as the getRepository() IDOR identified in the tier1 plan but specific to certification and training modules.

**HR-HIGH-015** (hr-expert, HIGH)
HR event publishing uses fire-and-forget pattern (DomainEventPublisher without outbox). Leave approval, termination, and certification events can be silently lost if NATS is temporarily unavailable.

**HR-HIGH-016** (hr-expert, HIGH)
File: apps/hr-service/src/leave/handlers/cancel-leave.handler.ts
CancelLeave handler calls async method without await. The floating promise means cancellation may silently fail with no error propagated to caller.

**HR-HIGH-017** (hr-expert, HIGH)
File: web/modules/hr-module/src/components/EmployeeDetail.tsx
National ID (TC kimlik) displayed unmasked in frontend. Should show only last 4 digits. PII exposure to any user with HR module access.

**HR-HIGH-018** (hr-expert, HIGH)
Hardcoded English strings throughout HR module (labels, error messages, validation messages). No i18n infrastructure. Turkish-language deployment requires code changes.

## Affected Files
- apps/hr-service/src/certification/handlers/certification.handler.ts
- apps/hr-service/src/hr/handlers/*.ts
- apps/hr-service/src/leave/handlers/cancel-leave.handler.ts
- web/modules/hr-module/src/components/EmployeeDetail.tsx
- web/modules/hr-module/src/ (i18n integration)

## Dependencies
HR-HIGH-018 (i18n) is a frontend finding that touches the same module as HR-HIGH-017 (national ID masking). Grouped for file locality.

## Atomic Commit Plan
```
security(hr): add cert transactions, fix repo tenant scoping, outbox events, mask national ID

Cert handlers not transactional. Injected repos bypass search_path. Events
fire-and-forget (no outbox). CancelLeave has floating promise. National ID
unmasked in frontend. Hardcoded English strings.

Wrap cert handlers in QueryRunner transactions. Replace injected repos with
getScopedRepository(). Migrate critical HR events to outbox pattern. Add
await to CancelLeave async call. Mask national ID to last 4 digits in
frontend. Extract string literals to i18n resource files.

Plan: docs/plans/2026-04-09-high-fixes/packages/19-hr-outbox-repo-i18n.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-013
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-014
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-015
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-016
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-017
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-018
```

## Test Plan
- Unit test: cert handler rolls back all changes on partial failure
- Unit test: repo queries include tenantId in WHERE clause
- Unit test: HR events enqueued in outbox within transaction
- Unit test: CancelLeave handler awaits the async operation
- Unit test: national ID display shows ***-****-1234 format
- Frontend test: i18n resource files loaded for TR locale

## Verification Command
`npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src/(certification|leave|hr)" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
