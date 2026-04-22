# Water Chemistry — History Tab Implementation Plan

**Goal:** Add a "History" tab to `/sites/water-chemistry` that shows historical water quality parameters with trend charts, data table, and statistics.

**Architecture:** Convert single-page calculator to tab-based layout. Existing tab = "Calculator", new tab = "History". Backend + hooks + GraphQL operations already exist — only frontend UI needed.

**Existing Infrastructure (no backend changes needed):**
- Entity: `WaterQualityMeasurement` — 30+ parameters, status evaluation, alarms
- Resolver: `waterQualityMeasurements`, `waterQualityChart`, `waterQualityStatistics`
- Hooks: `useWaterQualityList`, `useWaterQualityChart`, `useWaterQualityStatistics`, `useTankList`
- Types: All typed in `useWaterQuality.ts`

---

## Task 1: Convert WaterChemistryPage to Tab Layout

Wrap existing calculator content in a tab container. Add "Calculator" and "History" tabs using URL search params (same pattern as FeedingPage).

**File:** `web/modules/farm-module/src/pages/water-chemistry/WaterChemistryPage.tsx`

## Task 2: Create HistoryTab Component

New component with:
1. **Filters bar** — Tank selector, date range (7d/30d/90d/custom), status filter
2. **Statistics summary cards** — Avg Temp, Avg DO, Avg pH, Avg Ammonia, Measurement count, Critical/Warning counts
3. **Trend chart** — Multi-line Recharts (Temperature, DO, pH, Ammonia, Nitrite) over time for selected tank
4. **Data table** — Paginated measurement list with columns: Date, Tank, Temp, DO, pH, NH3, NO2, Status, Source

**File:** `web/modules/farm-module/src/pages/water-chemistry/components/HistoryTab.tsx`
