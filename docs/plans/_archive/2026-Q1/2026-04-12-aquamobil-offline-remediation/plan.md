# Implementation Plan: AquaMobil Offline Sync Remediation

## Context
Generated: 2026-04-12
Base Commit: 228554947916f7092ce851ca2076f72cdbb59a74
Total Packages: 7
HIGH: 4 | MEDIUM: 3

## Source Reports
- /var/aqua-saas/docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/test-audits/context-manager/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/recommendations/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md

## Prior Plan Deduplication
Two earlier planning documents overlap partially with this space:

- `docs/plans/2026-03-27-aquamobil-pwa-bugfix-plan.md`
- `docs/plans/2026-03-27-messaging-delivery-fix.md`

They predate the validated 2026-04-12 mobile audit and do not close the now-proven defects around queue UUID misuse, hidden messaging queue ownership, `/mobile` basename routing, or immediate leave readback convergence. This plan is authoritative for the current AquaMobil offline/remediation cycle and should be treated as the execution source for findings `HIGH-001`, `HIGH-002`, `HIGH-003`, `MEDIUM-004`, `MEDIUM-005`, and `MEDIUM-006`.

## Package Index

### Sprint 0 -- Structural Blockers
- [ ] 01-aquamobil-leave-authoritative-submit -- Replace the mobile leave timeout chain with one authoritative submit flow [HIGH] [parallelizable]
- [ ] 03-aquamobil-messaging-authoritative-offline-queue -- Unify offline messaging under the authoritative queue and visible pending surfaces [HIGH] [parallelizable]
- [ ] 06-aquamobil-permissions-fail-closed -- Replace permissive degraded-mode access with a fail-closed policy [MEDIUM] [security-sensitive] [parallelizable]

### Sprint 1 -- Convergence and Handoff
- [ ] 02-aquamobil-leave-readback-convergence -- Make mobile leave readback converge immediately after submit/queue [MEDIUM] (after 01)
- [ ] 04-aquamobil-sw-handoff-basename-routing -- Complete service-worker/client messaging handoff and make push routing `/mobile`-aware [HIGH] (after 03)

### Sprint 2 -- User-Visible Truth
- [ ] 05-aquamobil-truthful-queued-state-ui -- Align leave, task, and messaging UI states with queued vs confirmed semantics [HIGH] (after 02, 03)

### Sprint 3 -- Validation
- [ ] 07-aquamobil-mobile-offline-regression-harness -- Add targeted regression coverage and re-run the orchestrated mobile audit [MEDIUM] (after 02, 04, 05, 06)

## Ownership Boundaries
- `01-aquamobil-leave-authoritative-submit` owns leave write semantics: contract-valid payload, dedup fingerprint, queue/domain ID separation, and authoritative submit flow. It does not own list invalidation or final user copy.
- `02-aquamobil-leave-readback-convergence` owns leave query invalidation, cache updates, and immediate post-submit readback behavior. It does not redesign the underlying write contract.
- `03-aquamobil-messaging-authoritative-offline-queue` owns messaging queue ownership, replay, retry, and pending-count integration across sync surfaces. It does not own notification navigation or final UI copy.
- `04-aquamobil-sw-handoff-basename-routing` owns service-worker event handling and `/mobile`-aware routing contracts only.
- `05-aquamobil-truthful-queued-state-ui` owns user-facing queued/syncing/confirmed/failed semantics for leave, tasks, and messaging. It does not own queue infrastructure.
- `06-aquamobil-permissions-fail-closed` owns degraded-mode permission behavior and route visibility safety.
- `07-aquamobil-mobile-offline-regression-harness` owns regression coverage and post-fix audit rerun only; it should not introduce production behavior changes.

## Dependency Graph
See: docs/plans/2026-04-12-aquamobil-offline-remediation/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-12-aquamobil-offline-remediation/verification-log.md (append-only)

## Progress Summary
Completed: 0 / 7 packages
Last Updated: 2026-04-12
