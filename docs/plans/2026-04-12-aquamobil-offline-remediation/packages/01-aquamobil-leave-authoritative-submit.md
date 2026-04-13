# Package 01: aquamobil-leave-authoritative-submit

## Metadata
Status: PENDING
Estimated Tokens: 24K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes (no prerequisites)
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [orchestrator/HIGH-001, context-manager/HIGH-001]

## Source-Reviews
- /var/aqua-saas/docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/test-audits/context-manager/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/recommendations/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md

## Context
The current AquaMobil leave flow is structurally broken. The mobile page queues a create payload that does not match the backend contract, deduplication never activates because the payload lacks the resource identity the queue expects, and the follow-up submit call uses the offline queue UUID as if it were the domain leave-request ID. This must be replaced with one authoritative write path.

## Findings
- `HIGH-001`: mobile leave create payload omits required contract fields and uses incompatible half-day semantics.
- `HIGH-001`: queue dedup for HR writes keys off `employeeId`, but the queued leave payload has no `employeeId`, so repeated taps are not structurally suppressed.
- `HIGH-001`: the UI calls `submitLeaveRequest(queueId)` even though `queueId` is the offline-operation UUID, not the leave-request aggregate ID.

## Affected Files
- /var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx
- /var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts
- /var/aqua-saas/web/apps/aquamobil/src/types/index.ts
- /var/aqua-saas/web/apps/aquamobil/src/graphql/operations.ts
- /var/aqua-saas/apps/hr-service/src/leave/dto/create-leave-request.input.ts
- /var/aqua-saas/apps/hr-service/src/leave/leave.resolver.ts
- /var/aqua-saas/apps/hr-service/src/leave

## Dependencies
None.

## Atomic Commit Plan
```text
feat(aquamobil): replace leave timeout chain with authoritative submit flow

AquaMobil queued an invalid leave-create payload, could not reliably
dedupe repeated submits, and then called submitLeaveRequest with the
offline queue UUID instead of the server-issued leave request ID.
Replace the current client-managed create->timeout->submit chain with
one authoritative submit flow that uses a contract-valid payload and
real domain IDs.

Plan: docs/plans/2026-04-12-aquamobil-offline-remediation/packages/01-aquamobil-leave-authoritative-submit.md
Closes: docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md#HIGH-001
```

## Test Plan
- Add/extend HR leave mutation tests to prove the chosen authoritative submit path accepts valid self-service mobile input and returns a real leave-request ID.
- Add frontend tests to prove the leave page no longer calls `submitLeaveRequest` with the offline queue UUID.
- Add queue tests to prove repeated taps within the dedup window do not enqueue duplicate leave operations.
- Add regression coverage for half-day mapping so mobile payload semantics match backend expectations.

## Verification Command
```bash
npx tsc --noEmit -p web/apps/aquamobil/tsconfig.json && \
npx tsc --noEmit -p apps/hr-service/tsconfig.json && \
nx test hr-service --runInBand && \
npx vitest run web/apps/aquamobil/src/hooks web/apps/aquamobil/src/pwa
```

Dispatch: hr-expert

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes

