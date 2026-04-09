# Package 29: frontend-i18n-date-remaining

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 25K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Closing-Findings: [FE-HIGH-020, FE-HIGH-021, FE-HIGH-022, FE-HIGH-023, FE-HIGH-027, FE-HIGH-028, FE-HIGH-029, FE-HIGH-031, FE-HIGH-033, FE-HIGH-034, FE-HIGH-035, FE-HIGH-036]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Remaining frontend HIGHs: i18n infrastructure missing (all strings hardcoded), date formatting ignores timezone (UTC shown to users in local timezone), and additional findings for chart rendering, data export, error boundary, and mobile-specific issues.

## Findings

**FE-HIGH-020 through FE-HIGH-023** (frontend-expert, HIGH)
No i18n infrastructure. All UI strings hardcoded in English. Turkish deployment requires code changes. Date formatting uses toLocaleDateString() without timezone parameter, showing server UTC times as local times. Dashboard chart components use fixed English labels.

**FE-HIGH-027 through FE-HIGH-029** (frontend-expert, HIGH)
Data export downloads have no progress indicator (user cannot tell if export is running). Error boundary component does not capture async errors. Mobile PWA install prompt not implemented per platform requirements.

**FE-HIGH-031** (frontend-expert, HIGH)
SCADA widget custom HTML rendering uses dangerouslySetInnerHTML without sanitization. XSS via custom widget HTML content.

**FE-HIGH-033 through FE-HIGH-036** (frontend-expert, HIGH)
Sensor chart real-time update causes full re-render (performance). Farm map component loads all markers at once (performance with 1000+ farms). Notification panel has no pagination (unbounded DOM growth). Mobile offline data sync has no conflict resolution.

## Affected Files
- web/shared-ui/src/i18n/ (new infrastructure)
- web/shared-ui/src/utils/date.ts
- web/modules/*/src/ (string extraction)
- web/modules/sensor-module/src/components/scada-builder/
- web/modules/farm-module/src/components/FarmMap.tsx
- web/shell/src/notifications/NotificationPanel.tsx
- web/apps/aquamobil/src/sync/

## Dependencies
None.

## Atomic Commit Plan
```
feat(frontend): add i18n infrastructure, timezone-aware dates, fix XSS and performance

All UI strings hardcoded. Date formatting ignores timezone. SCADA custom HTML
allows XSS. Charts cause full re-render. Farm map loads all markers. No export
progress. No notification pagination. No offline conflict resolution.

Add react-intl i18n infrastructure with TR/EN locales. Use Intl.DateTimeFormat
with explicit timezone. Sanitize custom HTML with DOMPurify. Add React.memo
and virtualization to charts. Implement marker clustering on farm map. Add
pagination to notification panel. Add offline conflict resolution with
last-write-wins + merge for non-conflicting fields.

Plan: docs/plans/2026-04-09-high-fixes/packages/29-frontend-i18n-date-remaining.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-020
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-021
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-022
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-023
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-027
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-028
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-029
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-031
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-033
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-034
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-035
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-036
```

## Test Plan
- Unit test: i18n provider renders Turkish strings when locale=tr
- Unit test: date formatting includes timezone
- Unit test: custom HTML sanitized (script tags removed)
- Performance test: chart re-render time under 16ms
- Unit test: notification panel renders first 50 items
- Unit test: offline sync detects and resolves conflicts

## Verification Command
`npx tsc --noEmit -p web/shell/tsconfig.json && npx vitest run web/`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
