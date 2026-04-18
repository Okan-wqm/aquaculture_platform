# Implementation Plan: 2026-04-11 Full Platform E2E Audit Fixes

## Context
Generated: 2026-04-13
Base Commit: f7982867
Source Reports:
  - docs/test-audits/orchestrator/2026-04-11-full-platform-e2e.md
  - docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md
  - docs/test-audits/tenant-isolation-auditor/2026-04-11-full-platform-e2e.md
  - docs/test-audits/access-boundary-auditor/2026-04-11-full-platform-e2e.md
  - docs/test-audits/workflow-state-auditor/2026-04-11-full-platform-e2e.md
  - docs/test-audits/realtime-sync-auditor/2026-04-11-full-platform-e2e.md
  - docs/test-audits/chart-widget-auditor/2026-04-11-full-platform-e2e.md
Total Packages: 10
CRITICAL: 3 | HIGH: 6 | MEDIUM: 3

## Deduplication Notes
- docs/plans/2026-04-12-aquamobil-offline-remediation/ -- covers AquaMobil offline/sync/queue findings. No overlap with this plan.
- docs/plans/2026-04-09-critical-fixes/ -- covers 45 prior CRITICALs. No overlap with this plan.
- docs/plans/2026-04-09-high-fixes/ -- covers prior HIGHs. No overlap with this plan.

## Package Index
- [x] 01-nats-edge-device-tenant-scoped-routing -- Verify device-to-tenant ownership in NATS bridge before broadcasting [CRITICAL] [security-sensitive]
- [x] 02-user-deleted-tenant-verification -- Verify tenantId from UserDeleted event against actual user tenant before destructive writes [CRITICAL] [security-sensitive]
- [x] 03-mobile-settings-role-enforcement -- Add @TenantAdminOrHigher() to admin-only MobileSettingsResolver methods [CRITICAL] [security-sensitive]
- [x] 04-archive-channel-membership-fix -- Change leftAt: undefined to leftAt: IsNull() in archive-channel handler [HIGH]
- [x] 05-edge-device-maintenance-terminal-guard -- Reject maintenance mode toggle for DECOMMISSIONED devices [HIGH]
- [x] 06-task-event-integrity -- Migrate to OutboxPublisher and fix hardcoded previousStatus in task lifecycle [HIGH]
- [x] 07-tenant-admin-cache-key-scoping -- Add tenantId to React Query cache keys in tenant-admin hooks [HIGH]
- [x] 08-web-shell-access-type-enforcement -- Block MOBILE_ONLY users from web panel in ProtectedRoute [HIGH]
- [x] 09-billing-analytics-dashboard-truthfulness -- Remove hardcoded billing KPIs and fabricated DAU synthesis [MEDIUM]
- [x] 10-chart-single-point-nan-guard -- Handle data.length === 1 edge case in chart division [MEDIUM]

## Dependency Graph
See: docs/plans/2026-04-13-e2e-audit-fixes/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-13-e2e-audit-fixes/verification-log.md (append-only)

## Senior Engineer Review Notes (2026-04-13)

The implementation-planner agent generated the initial plan structure. A senior engineer
reviewed and corrected the following issues the planner missed:

### Package 01 & 02 — NATS Subject Mismatch (planner missed)
`NatsEventBus.deriveSubject()` at `platform/libs/event-bus/src/nats/nats-event-bus.ts:341-344`
produces tenant-scoped subjects: `events.{tenantId}.{eventType}`. Both the gateway bridge
(raw NATS subscribe) and the messaging handler (`@EventPattern`) subscribe to subjects WITHOUT
the tenant segment. This means:
- The subscriptions likely do not receive events at all (subject mismatch)
- The fix is to use wildcard subscriptions (`events.*.{eventType}`) and extract tenantId from
  the subject (authoritative) instead of the payload (untrusted)
- Packages 01 and 02 have been updated with the correct fix approach

### Package 06 — OutboxPublisher Already Available (planner missed)
Farm-service already has `@platform/outbox` fully wired with `FarmOutboxModule` registered
globally. Every other handler (harvest, mortality, feeding, allocation, etc.) already uses
`OutboxPublisher.enqueue()`. `task.service.ts` is the ONLY remaining handler on the old
`eventBus.publish()` pattern. Package 06 has been updated to specify migration to
OutboxPublisher, not "propagate failure or use outbox if available."

### Findings Not Included (intentional exclusions)
The original audit reports listed 55 findings (3 CRITICAL, 34 HIGH, 17 MEDIUM, 1 LOW).
After source code verification, ~24 findings were identified as incomplete features / TODO
stubs mislabeled as HIGH (e.g., message delete no-op, media viewer stub, invoice download
placeholder, AI persona page mock). These are feature work, not bug fixes, and are excluded
from this remediation plan. The AquaMobil offline/sync findings are already covered by
`docs/plans/2026-04-12-aquamobil-offline-remediation/`.

## Progress Summary
Completed: 10 / 10 packages
Last Updated: 2026-04-13
