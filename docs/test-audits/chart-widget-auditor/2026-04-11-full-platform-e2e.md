# Chart Widget Auditor Review

- Topic: `2026-04-11-full-platform-e2e`
- Scope: full-platform chart, KPI, dashboard, widget, gauge, and trend truth
- Status: review-only

## Findings

### HIGH-001 Billing dashboard invents live billing KPIs that the backend does not provide
- Surface: [web/modules/admin-panel/src/pages/BillingDashboardPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:395) and [web/modules/admin-panel/src/pages/BillingDashboardPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:476)
- Source of truth: [apps/admin-api-service/src/analytics/services/analytics.service.ts](/var/aqua-saas/apps/admin-api-service/src/analytics/services/analytics.service.ts:1049) only returns `totalRevenue`, `mrr`, `arr`, `averageRevenuePerTenant`, `revenueByPlan`, and `revenueByMonth`
- Root cause: `transformRevenueData()` hardcodes `churnRate`, `outstandingInvoices`, `growth`, and `paymentSuccessRate` instead of binding them to a real endpoint or read model
- Impact: the dashboard renders billing KPIs as if they are operational truth, but those values are fabricated client-side and can drive false finance and collections decisions
- Cross-domain dependency: this is a dashboard truth issue that also touches backend report/model design; the missing metrics belong in `schema-surface-parity-auditor` and `data-readback-auditor`

### HIGH-002 Daily Active Users is rendered from tenant growth, not user activity
- Surface: [web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx:698) and [web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx:433)
- Source of truth: [apps/admin-api-service/src/analytics/controllers/analytics.controller.ts](/var/aqua-saas/apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:161) exposes `GET /analytics/users/activity`, and [apps/admin-api-service/src/analytics/services/analytics.service.ts](/var/aqua-saas/apps/admin-api-service/src/analytics/services/analytics.service.ts:352) returns the actual `Daily Active Users` trend
- Root cause: the page never queries the user-activity trend endpoint; it fetches tenant growth, then multiplies tenant counts by `avgUsersPerTenant` to synthesize `userTrend`
- Impact: the `Daily Active Users` chart visually implies a real usage series but is actually an estimate derived from an unrelated tenant-growth curve
- Cross-domain dependency: this should be reconciled with `data-readback-auditor` because the real user activity series already exists in the backend

### HIGH-003 Module usage and feature adoption panels show zero-filled placeholders as live analytics
- Surface: [web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx:796) and [web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx:825)
- Source of truth: [apps/admin-api-service/src/analytics/services/analytics.service.ts](/var/aqua-saas/apps/admin-api-service/src/analytics/services/analytics.service.ts:648) logs that detailed module usage requires audit-log analysis, then returns zeros for `moduleUsage`, `featureAdoption`, and `topFeatures`; [apps/admin-api-service/src/analytics/services/analytics.service.ts](/var/aqua-saas/apps/admin-api-service/src/analytics/services/analytics.service.ts:696) and [apps/admin-api-service/src/analytics/services/analytics.service.ts](/var/aqua-saas/apps/admin-api-service/src/analytics/services/analytics.service.ts:713) do the same for the dedicated chart endpoints
- Root cause: the backend currently degrades these metrics into structurally valid zero objects, but the frontend has no degraded-state marker and renders them as real adoption/usage data
- Impact: the page can present zero adoption and zero usage as if they were measured facts, which is materially misleading on an operations dashboard
- Cross-domain dependency: this is a backend aggregation gap plus a frontend truth-display gap; it belongs with `schema-surface-parity-auditor` and `realtime-sync-auditor`

### MEDIUM-004 Shared chart primitives break or degrade on single-point series
- Surface: [web/shared-ui/src/components/Charts/LineChart.tsx](/var/aqua-saas/web/shared-ui/src/components/Charts/LineChart.tsx:82), [web/shared-ui/src/components/Charts/AreaChart.tsx](/var/aqua-saas/web/shared-ui/src/components/Charts/AreaChart.tsx:76), and the admin mini chart in [web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx:261)
- Source of truth: any trend source that collapses to a single datapoint is still valid operational data, especially for new tenants, short windows, or sparse histories
- Root cause: the coordinate math divides by `(data.length - 1)` / `(labels.length - 1)` with no one-point guard, so one-point series become `Infinity` / `NaN` or silently disappear
- Impact: trend widgets can render broken geometry or vanish entirely instead of showing a degenerate point, which makes sparse but valid data unreadable
- Cross-domain dependency: these primitives are used by multiple surfaces, so the fix needs to be applied once in the shared chart layer rather than patched per dashboard

## Verdict

The chart/widget layer is not enterprise-truth clean yet. The biggest gaps are false billing KPIs, a synthetic DAU series, placeholder usage/adoption analytics, and a shared sparse-series rendering defect.
