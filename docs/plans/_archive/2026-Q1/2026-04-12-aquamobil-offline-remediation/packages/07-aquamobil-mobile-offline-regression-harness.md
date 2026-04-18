# Package 07: aquamobil-mobile-offline-regression-harness

## Metadata
Status: PENDING
Estimated Tokens: 16K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: no
Prerequisites: 02-aquamobil-leave-readback-convergence, 04-aquamobil-sw-handoff-basename-routing, 05-aquamobil-truthful-queued-state-ui, 06-aquamobil-permissions-fail-closed
Sprint: 3

## Closing-Findings
Closing-Findings: [orchestrator/HIGH-001, orchestrator/HIGH-002, orchestrator/HIGH-003, orchestrator/MEDIUM-004, orchestrator/MEDIUM-005, orchestrator/MEDIUM-006]

## Source-Reviews
- /var/aqua-saas/docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/test-audits/context-manager/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/recommendations/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md

## Context
The validated AquaMobil defects cut across queue ownership, domain IDs, service-worker routing, and user-visible state semantics. After implementation, a focused regression harness must prove those paths end-to-end and the orchestrated mobile audit must be rerun so the review artifacts reflect the post-remediation truth.

## Findings
- The current findings were established by static audit plus targeted deep review, not by a dedicated post-fix regression suite.
- Leave and messaging both need explicit offline/reconnect proof, not only unit-level correctness.

## Affected Files
- /var/aqua-saas/web/apps/aquamobil/src/pwa/__tests__/offline-queue.spec.ts
- /var/aqua-saas/web/apps/aquamobil/src/hooks
- /var/aqua-saas/web/apps/aquamobil/src/pages/leave
- /var/aqua-saas/web/apps/aquamobil/src/pages/messaging
- /var/aqua-saas/web/apps/aquamobil/src/pages/tasks
- /var/aqua-saas/docs/test-audits/orchestrator
- /var/aqua-saas/docs/test-audits/context-manager

## Dependencies
- 02-aquamobil-leave-readback-convergence
- 04-aquamobil-sw-handoff-basename-routing
- 05-aquamobil-truthful-queued-state-ui
- 06-aquamobil-permissions-fail-closed

## Atomic Commit Plan
```text
test(aquamobil): add offline leave and messaging regression coverage

The AquaMobil offline/remediation work changes queue ownership,
service-worker routing, permission fallback behavior, and UI truth
semantics. Add targeted regression coverage for leave and messaging
offline/reconnect flows, then rerun the orchestrated mobile audit so
the review artifacts reflect the remediated state.

Plan: docs/plans/2026-04-12-aquamobil-offline-remediation/packages/07-aquamobil-mobile-offline-regression-harness.md
Closes: docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
```

## Test Plan
- Add regression coverage for: online leave submit -> immediate list readback.
- Add regression coverage for: offline leave submit -> reconnect -> converged readback.
- Add regression coverage for: double-tap leave submit under degraded network.
- Add regression coverage for: offline messaging send -> reconnect replay -> visible pending count removal.
- Add regression coverage for: push notification click with and without an already-open messaging window.
- Add regression coverage for: permission-fetch failure with no cache.
- Re-run the AquaMobil orchestrated mobile audit and update the audit artifacts under `docs/test-audits/orchestrator` and `docs/test-audits/context-manager`.

## Verification Command
```bash
npx tsc --noEmit -p web/apps/aquamobil/tsconfig.json && \
npx vitest run web/apps/aquamobil && \
nx test hr-service --runInBand
```

Dispatch: test-runner

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes

