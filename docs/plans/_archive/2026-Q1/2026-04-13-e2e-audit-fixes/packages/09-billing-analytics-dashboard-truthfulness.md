# Package 09: billing-analytics-dashboard-truthfulness

## Metadata
Status: PENDING
Estimated Tokens: ~18K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes (with 10)
Prerequisites: 07-tenant-admin-cache-key-scoping, 08-web-shell-access-type-enforcement

## Source Reviews
- docs/test-audits/chart-widget-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [chart-widget-auditor/HIGH-001, chart-widget-auditor/HIGH-002]

## Context
Two admin dashboard pages present fabricated metrics as live data:
1. BillingDashboardPage hardcodes `churnRate: 2.3`, `outstandingInvoices: 12`, `paymentSuccessRate: 98.5` with comments "Would come from separate API". These are displayed as real-time KPIs.
2. AnalyticsDashboardPage synthesizes Daily Active Users by multiplying tenant count by avgUsersPerTenant -- this fabricates user activity data from tenant growth trends.

Both findings were downgraded from HIGH to MEDIUM by the verifying engineer because the admin dashboard is not customer-facing and the hardcoded values are clearly commented as placeholder. However, they still present false information to tenant administrators making business decisions.

## Findings
chart-widget-auditor HIGH-001 (downgraded to MEDIUM): Billing dashboard hardcoded KPIs.
- File: `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx` lines 70-75
- `churnRate: 2.3`, `outstandingInvoices: 12`, `paymentSuccessRate: 98.5` hardcoded with comments "Would come from separate API". Shown as live metrics.
- Severity: MEDIUM (downgraded from HIGH)
- Gap class: read-gap, visibility-gap, schema-gap

chart-widget-auditor HIGH-002 (downgraded to MEDIUM): DAU chart synthesized from tenant growth.
- File: `web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx` lines 446-449
- `setUserTrend(trendData.map(d => ({...value: Math.round(d.value * avgUsersPerTenant)})))` -- fabricated user activity from tenant counts.
- Severity: MEDIUM (downgraded from HIGH)
- Gap class: read-gap, visibility-gap, schema-gap

## Affected Files
- web/modules/admin-panel/src/pages/BillingDashboardPage.tsx (primary -- lines 70-75, replace hardcoded values)
- web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx (primary -- lines 446-449, replace synthesized DAU)

## Dependencies
Prerequisites: Tier 3 packages (07, 08) must be committed first (tier ordering).
This package touches only the admin-panel frontend module. No backend changes.

## Atomic Commit Plan
```
fix(admin-panel): remove fabricated billing KPIs and synthesized DAU chart data

BillingDashboardPage hardcodes churnRate, outstandingInvoices, and
paymentSuccessRate as if they were live metrics. AnalyticsDashboardPage
fabricates Daily Active Users by multiplying tenant count by
avgUsersPerTenant. Both present false data to administrators.

Replace hardcoded billing KPIs with explicit "No data available" or
"Coming soon" placeholders that make the absence of a real API honest.
Replace synthesized DAU with either a real user activity endpoint (if
available) or an honest "Not yet implemented" state.

Addresses: chart-widget-auditor/HIGH-001, chart-widget-auditor/HIGH-002

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/09-billing-analytics-dashboard-truthfulness.md
Closes: docs/test-audits/chart-widget-auditor/2026-04-11-full-platform-e2e.md#HIGH-001
Closes: docs/test-audits/chart-widget-auditor/2026-04-11-full-platform-e2e.md#HIGH-002
```

## Test Plan
- Visual verification: BillingDashboardPage no longer shows hardcoded numeric values for churnRate, outstandingInvoices, paymentSuccessRate.
- Visual verification: AnalyticsDashboardPage no longer shows a fabricated DAU trend line.
- Unit test: BillingDashboardPage renders with "No data" or equivalent for unavailable KPIs.
- Unit test: AnalyticsDashboardPage does not compute userTrend from tenantTrend multiplication.
- Type check: no TypeScript errors introduced.

## Verification Command
`npx tsc --noEmit -p web/modules/admin-panel/tsconfig.json && npx vitest run web/modules/admin-panel/src/pages`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
