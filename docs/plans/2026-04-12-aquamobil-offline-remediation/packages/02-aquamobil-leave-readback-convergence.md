# Package 02: aquamobil-leave-readback-convergence

## Metadata
Status: PENDING
Estimated Tokens: 12K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: no
Prerequisites: 01-aquamobil-leave-authoritative-submit
Sprint: 1

## Closing-Findings
Closing-Findings: [orchestrator/MEDIUM-006, context-manager/MEDIUM-006]

## Source-Reviews
- /var/aqua-saas/docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/test-audits/context-manager/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/recommendations/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md

## Context
Even after the write path is corrected, AquaMobil can still present stale leave state because the mobile mutation path does not invalidate `leaveRequests` or `leaveBalances` before routing back to `/leave`. The desktop HR module already contains the desired React Query invalidation pattern; mobile needs the same convergence discipline.

## Findings
- `MEDIUM-006`: `useSubmitLeaveRequest()` mutates server state but does not invalidate or update leave query data.
- `MEDIUM-006`: `MyLeavesPage` reads cached data with a 2-minute `staleTime`, so immediate post-submit readback is not trustworthy.
- `MEDIUM-006`: `LeaveRequestPage` routes back to `/leave` immediately after success copy, before proving cache convergence.

## Affected Files
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts
- /var/aqua-saas/web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/graphql/operations.ts

## Dependencies
- 01-aquamobil-leave-authoritative-submit

## Atomic Commit Plan
```text
refactor(aquamobil): make leave readback converge immediately after submit

The mobile leave mutation path mutates server state but leaves React
Query caches stale for up to two minutes, so workers can return to
My Leaves and see outdated request state. Align the mobile flow with
the desktop HR invalidation pattern and render queued vs confirmed
state explicitly.

Plan: docs/plans/2026-04-12-aquamobil-offline-remediation/packages/02-aquamobil-leave-readback-convergence.md
Closes: docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md#MEDIUM-006
```

## Test Plan
- Add React Query hook tests to prove leave mutations invalidate `leaveRequests` and `leaveBalances`.
- Add page-level tests to prove returning to `/leave` immediately after submit shows queued or updated state, not stale cached data.
- Add regression coverage to ensure list and balance data stay consistent after cancel/submit transitions.

## Verification Command
```bash
npx tsc --noEmit -p web/apps/aquamobil/tsconfig.json && \
npx vitest run web/apps/aquamobil/src/hooks web/apps/aquamobil/src/pages/leave
```

Dispatch: frontend-expert

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes

