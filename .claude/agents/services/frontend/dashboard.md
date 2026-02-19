---
name: dashboard
description: Knowledge base for the Dashboard frontend module
---

# Dashboard Knowledge Base

## Overview

The Dashboard module is a Module Federation remote that provides the main overview screen for authenticated users. It displays high-level KPIs (farms, sensors, alerts, production), recent activity, alerts summary, and quick actions. Content is currently partly mocked (static data with real-looking structure). Routes under `/dashboard/*`.

## Directory Structure

```
web/modules/dashboard/src/
  Module.tsx           # (not a file listed — routes are in routes.tsx / App.tsx)
  App.tsx              # Standalone app wrapper for local dev
  bootstrap.tsx        # MF bootstrap
  main.tsx             # Vite entry
  routes.tsx           # Route definitions
  styles.css           # Tailwind imports
  pages/
    DashboardPage.tsx  # Main overview page (KPIs + grids)
    AnalyticsPage.tsx  # Analytics tab page
  components/
    OverviewWidgets.tsx       # Grid of overview widgets
    RecentActivityList.tsx    # Recent activity feed
    AlertsSummary.tsx         # Active alert summary panel
    QuickActions.tsx          # Quick action buttons
    index.ts
  widgets/
    LiveSensorWidget.tsx      # Live sensor reading card (currently stub/empty)
    ProductionChart.tsx       # Production trend chart (currently stub/empty)
    RASFlowDiagram.tsx        # RAS flow diagram (currently stub/empty)
    WaterQualityGauge.tsx     # Water quality gauge widget
    AlertSummaryWidget.tsx    # Alert count widget
    __tests__/
      AlertSummaryWidget.spec.tsx
```

Note: Several widget files (`LiveSensorWidget.tsx`, `ProductionChart.tsx`, `RASFlowDiagram.tsx`) are currently empty/stub files.

## Pages / Components

### DashboardPage (`/dashboard`)
- Displays 4 KPI MetricCards: Total Farms, Active Sensors, Today's Alerts, Production (Tons)
- Each MetricCard shows a trend percentage
- Layout: 2/3 left column (`OverviewWidgets` + `RecentActivityList`), 1/3 right column (`AlertsSummary` + `QuickActions`)
- Data is currently hardcoded mock (`metrics` object) — `isLoading = false`
- Uses `useAuthContext()` for user name and `useTenantContext()` for tenant name
- Uses `formatNumber`, `formatRelativeTime` from `@aquaculture/shared-ui`
- UI text is in Turkish (e.g., "Toplam Çiftlik", "Aktif Sensör")

### AnalyticsPage (`/dashboard/analytics`)
- Analytics detail page (structure not fully examined)

## State Management

- No Zustand store in this module
- Uses `useAuthContext()` and `useTenantContext()` from `@aquaculture/shared-ui`
- No `@tanstack/react-query` in use yet (data is mocked)

## GraphQL Operations

Currently no live GraphQL queries in DashboardPage — data is hardcoded mock. Future integration will query:
- Farm list / count
- Active sensor count
- Alert count for today
- Production metrics

## Routing

```
/dashboard        -> DashboardPage
/dashboard/analytics -> AnalyticsPage
```

Routes are defined in `routes.tsx` and exposed via `Module.tsx` (or `App.tsx`).

## Key Dependencies

- `@aquaculture/shared-ui` — MetricCard, Card, Button, Badge, SkeletonCard, formatNumber, formatRelativeTime
- `react-router-dom` v6
- Tailwind CSS
- Webpack Module Federation (note: uses webpack config, not Vite)

## Known Gotchas

- DashboardPage data is completely mocked (`metrics` object, `isLoading = false`). No real API calls.
- Widget files `LiveSensorWidget.tsx`, `ProductionChart.tsx`, `RASFlowDiagram.tsx` are empty stubs (1 line files).
- UI is partially in Turkish — keep consistent when modifying.
- Uses `MetricCard` component from shared-ui (not standard HTML cards).
- This module uses webpack (`webpack.config.js`), not Vite. Build config differs from shell/farm-module.
- Dashboard intentionally links to `/sites/new` for "New Farm" quick action — cross-module navigation via absolute path.

## Related Backend Services

- **farm-service** — for farm/site counts (not yet wired)
- **sensor-service** — for active sensor counts and alerts (not yet wired)
- **gateway-api** — all GraphQL traffic endpoint
