# Chart Widget Auditor Review

- Topic: `2026-04-13-full-platform-e2e`
- Scope: `web/**`, `apps/**` -- all KPI cards, charts, dashboards, widgets, trend views, gauge displays
- Status: review-only
- Prior cycle: `2026-04-11-full-platform-e2e` -- HIGH-001, HIGH-002, HIGH-003, MEDIUM-004 fixed in commit 79ce984f

## Prior Cycle Regression Check

### HIGH-001 (Billing KPIs) -- RESOLVED
The `BillingDashboardPage.tsx` `transformRevenueData()` (line 64-74) now correctly sets `churnRate`, `outstandingInvoices`, `growth`, and `paymentSuccessRate` to `null` with TODO comments for future API wiring. The MetricCards at lines 409, 416, 479, 490 render `N/A` or `--` with `"Not yet connected"` subtitles when values are null. No fabricated KPIs remain on this surface.

### HIGH-002 (DAU) -- RESOLVED
`AnalyticsDashboardPage.tsx` line 447-449: `setUserTrend([])` with a TODO comment for wiring to the real `GET /analytics/users/activity` endpoint. The DAU chart at lines 700-712 renders an "Analytics not yet available" overlay when userTrend is empty. No synthetic multiplication of tenant counts.

### HIGH-003 (Module Usage / Feature Adoption) -- RESOLVED
`AnalyticsDashboardPage.tsx` lines 796-800 and 826-830: both sections now show "No analytics data available yet" when data is empty. Backend `analytics.service.ts` lines 668-691 still returns structurally-valid zeros for module usage, but the frontend now correctly detects empty objects and renders degraded state. Not misleading.

### MEDIUM-004 (Chart NaN on single-point) -- RESOLVED for shared library
`LineChart.tsx` line 86: `labels.length <= 1 ? chartWidth / 2 : (i / (labels.length - 1)) * chartWidth` -- single-point guard present. `AreaChart.tsx` line 77: same guard. No more NaN/Infinity on one-point series in the shared chart layer.

## New Findings

### HIGH-001 Churn Rate KPI card has hardcoded trend value on Analytics Dashboard

- **Surface:** `web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx` line 631
- **Source of truth:** `data.tenants.churnRate` is fetched from `analyticsApi.getDashboardSummary()` which returns a real churn rate, but the trend change is hardcoded as `change={-0.5}` and `trend="down"` regardless of actual period-over-period comparison
- **Root cause:** The KpiCard for Churn Rate passes a literal `-0.5` as the `change` prop and `"down"` as the `trend` prop. These values are never computed from backend data. The churn rate value itself is real, but the directional trend indicator is fabricated.
- **Impact:** The dashboard always shows churn as "improving by 0.5% vs last month" regardless of actual churn trajectory. This can mask a worsening churn trend, which is a material operational metric for a SaaS business.
- **Recommendation:** Wire `change` to a real period-over-period comparison from `getKpiComparisons()` (which already exists at `analytics.service.ts` line 749), or set to `undefined` until the endpoint is connected. Do not hardcode directional indicators on operational KPIs.

### HIGH-002 Dashboard MetricCard "Aktif Kullanici" shows sensorsTrend instead of user activity trend

- **Surface:** `web/modules/dashboard/src/pages/DashboardPage.tsx` lines 194-199
- **Source of truth:** `DashboardKPI.sensorsTrend` computed at `web/modules/dashboard/src/hooks/useDashboardData.ts` lines 528-534 represents `(activeSensors / totalSensors) * 100 - 100` -- a sensor health ratio, not a user activity trend
- **Root cause:** The "Aktif Kullanici" (Active Users) MetricCard passes `trend={metrics.sensorsTrend}` and `trendLabel="gecen haftaya gore"`. The metric value itself (`metrics.activeUsers`) is correct, but the trend arrow and percentage reflect sensor availability ratio, not user growth or activity change.
- **Impact:** The active users card displays a trend indicator that has no semantic relationship to user activity. An operator sees "active users up/down X% vs last week" but the percentage is actually about sensor health. This is a cross-domain truth error.
- **Recommendation:** Add a dedicated `usersTrend` field to `DashboardKPI` computed from `tenantStats.monthlyGrowthPercent` or a weekly active user delta. Pass that to the MetricCard instead of `sensorsTrend`.

### HIGH-003 Dashboard MetricCard "Toplam Kullanici" shows productionTrend instead of user trend

- **Surface:** `web/modules/dashboard/src/pages/DashboardPage.tsx` lines 214-219
- **Source of truth:** `DashboardKPI.productionTrend` computed at `useDashboardData.ts` lines 520-524 represents `((currentBiomass - prevBiomass) / prevBiomass) * 100` -- a harvest biomass comparison
- **Root cause:** The "Toplam Kullanici" (Total Users) MetricCard passes `trend={metrics.productionTrend}` and `trendLabel="bu ay"`. The metric value (`metrics.totalUsers`) is correct, but the trend arrow shows a percentage derived from fish harvest biomass changes.
- **Impact:** The total users card shows a trend indicator derived from aquaculture production data, not user growth. This is semantically misleading -- a fish harvest boom would appear as user growth.
- **Recommendation:** Create a `totalUsersTrend` field in `DashboardKPI` computed from actual user count changes. Remove the production trend from this card.

### HIGH-004 HR Dashboard "Active Certifications" card uses expiringCertsCount as its value

- **Surface:** `web/modules/hr-module/src/pages/HRDashboardPage.tsx` lines 364-370
- **Source of truth:** `useExpiringCertifications(30)` returns certifications expiring within 30 days -- this is a filtered "about to expire" count, not a total active certifications count
- **Root cause:** The StatCard titled "Active Certifications" displays `expiringCertsCount` (line 366). The same variable is also correctly used in the "Expiring Certs" card at lines 379-387. Both cards show the same number but with different titles and semantics.
- **Impact:** The "Active Certifications" card tells operators they have N active certifications when in reality N is the number expiring soon. If 2 out of 200 certifications are expiring, the card reads "Active Certifications: 2" -- a 99% undercount of actual compliance status. This is a safety-relevant metric in aquaculture (diving certs, safety certs).
- **Recommendation:** Wire "Active Certifications" to a dedicated count query (e.g., `useActiveCertificationsCount()`) that counts all non-expired certifications. The `useExpiringCertifications(30)` hook belongs only on the "Expiring Certs" card.

### MEDIUM-001 MiniChart in AnalyticsDashboardPage lacks single-point NaN guard

- **Surface:** `web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx` lines 253-266 (inline `MiniChart` component)
- **Source of truth:** Any trend that collapses to a single data point (new tenant, first day, sparse history)
- **Root cause:** Line 262: `const x = (i / (data.length - 1)) * 100;` divides by zero when `data.length === 1`, producing `NaN` or `Infinity` for the SVG polyline coordinate. The shared chart library (`LineChart.tsx`, `AreaChart.tsx`) was fixed for MEDIUM-004 but this is a separate inline `MiniChart` component that was not part of that fix.
- **Impact:** When a single-point trend exists (e.g., first day of tenant growth data or revenue in a 7-day window with only one entry), the MiniChart polyline renders with `NaN` coordinates, producing either invisible or broken SVG. The chart simply vanishes without any user-visible error, making valid single-point data unreadable.
- **Recommendation:** Add `data.length <= 1 ? 50 : (i / (data.length - 1)) * 100` guard consistent with the shared chart library fix, or render a dot at center for single-point series.

### MEDIUM-002 HR Analytics department breakdown progress bars are permanently 0% width

- **Surface:** `web/modules/hr-module/src/pages/HRAnalyticsPage.tsx` lines 125-136
- **Source of truth:** The department list comes from `useDepartments()` which returns department metadata but not employee counts per department
- **Root cause:** Line 129: `width: '0%'` is hardcoded. The count label at line 134 displays `'-'`. The progress bar visualization suggests a proportional breakdown but always renders empty bars with no values. There is no query for employee-per-department counts wired to this view.
- **Impact:** The "Department Breakdown" section renders styled progress bars with department names and color codes, creating the visual expectation of a filled chart, but every bar is 0px wide. This is a placeholder visualization that looks like a broken chart to the operator.
- **Recommendation:** Either wire `width` and the count label to a real department-employee-count endpoint (such as a `GROUP BY departmentId` query), or remove the progress bar visualization and show the department list without the misleading bar UI until real data is available.

### MEDIUM-003 Backend module usage and feature adoption chart endpoints return hardcoded zeros

- **Surface:** `apps/admin-api-service/src/analytics/services/analytics.service.ts` lines 696-724
- **Source of truth:** `getModuleUsageChart()` (line 696) and `getFeatureAdoptionChart()` (line 713) return chart-shaped data with `data: [0, 0, 0, 0, 0, 0, 0]` and `data: [0, 0, 0, 0, 0, 0]` respectively
- **Root cause:** These endpoints emit structurally valid `ChartData` objects with correct labels and colors but zero values. They log warnings ("requires audit log analysis") but the response shape is indistinguishable from "usage is actually zero" to the frontend.
- **Impact:** While the frontend was fixed to show "No analytics data available yet" for the dashboard summary endpoint, these dedicated chart endpoints are still exposed via the API and could be consumed by other clients or future surfaces without awareness that the data is structurally valid but semantically empty.
- **Recommendation:** Add a `degraded: true` flag to the response or return HTTP 204/503 with a reason field so consumers can distinguish "real zeros" from "unimplemented metric." This prevents future chart consumers from rendering zeros as measured truth.
- **Cross-domain dependency:** `schema-surface-parity-auditor` -- backend contracts should declare degradation state.

### MEDIUM-004 console.error calls in AnalyticsDashboardPage violate code standards

- **Surface:** `web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx` lines 418, 479
- **Source of truth:** CLAUDE.md code quality standards: "`console.log` YASAK -> NestJS `Logger` kullan"
- **Root cause:** `console.error('Analytics API unavailable')` at line 418 and `console.error('Failed to load analytics data:', error)` at line 479 use raw console logging in a frontend module.
- **Impact:** Not a chart truth issue per se, but these console.error calls can leak diagnostic details to the browser console in production. They violate the structured logging standard.
- **Recommendation:** Replace with a structured logger or remove in favor of the existing error state handling which already sets `setData(getDefaultData())`.

### LOW-001 SparklineChart silently hides single-point data

- **Surface:** `web/shared-ui/src/components/Charts/SparklineChart.tsx` lines 42, 74
- **Source of truth:** Any metric with exactly one data point
- **Root cause:** Line 42-43 returns empty for `data.length < 2`. Line 74 also returns an empty div. The SparklineChart requires minimum 2 points. However, unlike the LineChart/AreaChart which were fixed to show a centered dot, the SparklineChart simply renders nothing.
- **Impact:** Any card or table cell using SparklineChart with a single-point series shows a blank space with no indication that data exists. Valid sparse data is silently hidden.
- **Recommendation:** Render a single centered dot for one-point data instead of returning empty, consistent with the shared chart library pattern.

### LOW-002 Revenue chart on BillingDashboardPage is a static placeholder

- **Surface:** `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx` lines 434-451
- **Source of truth:** `revenueByMonth` data is returned by `analyticsApi.getRevenueAnalytics()` but is not used
- **Root cause:** Lines 443-449 render a static dashed-border placeholder with an SVG icon and the text "Revenue Chart" instead of using the available `revenueByMonth` data from the API response.
- **Impact:** The billing dashboard has revenue trend data available from the backend but does not render it. The placeholder visually occupies the chart space but provides no information. Not fabricated data -- it is clearly a placeholder -- but it represents an incomplete surface where real data exists but is not visualized.
- **Recommendation:** Wire the revenue chart to `data.revenueByMonth` from the existing `RevenueAnalytics` response and render using the shared `BarChart` or `AreaChart` component.

## Summary

| ID | Severity | Surface | Issue |
|----|----------|---------|-------|
| HIGH-001 | HIGH | AnalyticsDashboardPage:631 | Churn Rate KPI trend hardcoded as -0.5/down |
| HIGH-002 | HIGH | DashboardPage:197 | "Aktif Kullanici" trend shows sensorsTrend |
| HIGH-003 | HIGH | DashboardPage:217 | "Toplam Kullanici" trend shows productionTrend |
| HIGH-004 | HIGH | HRDashboardPage:366 | "Active Certifications" card uses expiringCertsCount |
| MEDIUM-001 | MEDIUM | AnalyticsDashboardPage:262 | MiniChart NaN on single-point series |
| MEDIUM-002 | MEDIUM | HRAnalyticsPage:129 | Department breakdown bars permanently 0% width |
| MEDIUM-003 | MEDIUM | analytics.service.ts:696-724 | Module/feature chart endpoints return hardcoded zeros |
| MEDIUM-004 | MEDIUM | AnalyticsDashboardPage:418,479 | console.error violates structured logging standard |
| LOW-001 | LOW | SparklineChart.tsx:42 | Single-point data silently hidden (empty render) |
| LOW-002 | LOW | BillingDashboardPage:434-451 | Revenue chart is static placeholder despite available data |

## Prior Findings Status

| Prior ID | Status | Evidence |
|----------|--------|----------|
| HIGH-001 (billing KPIs) | RESOLVED | commit 79ce984f -- null values with N/A display |
| HIGH-002 (DAU synthetic) | RESOLVED | commit 79ce984f -- userTrend set to empty with TODO |
| HIGH-003 (module usage zeros) | RESOLVED | commit 79ce984f -- empty-state overlay on frontend |
| MEDIUM-004 (chart NaN) | RESOLVED | commit 79ce984f -- single-point guard in LineChart/AreaChart |

## Systemic Pattern

Three of the four HIGH findings in this cycle (HIGH-001, HIGH-002, HIGH-003) follow the same anti-pattern: **trend indicators disconnected from their metric's semantic domain**. The KPI card value is correct, but the accompanying trend arrow/percentage comes from an unrelated data source or is hardcoded. This pattern is easy to introduce when trend data is scarce and the temptation is to "show something" rather than show nothing.

**Architectural recommendation:** Create a `KpiTrendBinding` type that enforces that a MetricCard's `trend` prop must be sourced from the same semantic domain as its `value` prop. If no real trend is available, render no trend indicator rather than a misleading one.

## Verdict

The prior cycle's fixes are confirmed resolved. Four new HIGH findings exist, all involving trend/label mismatch or semantic confusion on operational KPIs. The core chart library is now single-point safe, but the inline MiniChart in AnalyticsDashboardPage was missed. The HR dashboard has a safety-relevant label/data mismatch on certifications. The platform's chart truth is improving but the trend-binding pattern needs architectural enforcement to prevent recurrence.
