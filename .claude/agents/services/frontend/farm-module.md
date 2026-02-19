---
name: farm-module
description: Knowledge base for the Farm Module frontend
---

# Farm Module Knowledge Base

## Overview

The largest frontend module. Handles all farm/site operations: farm CRUD, tank management, batch production lifecycle, feeding programs and daily execution, equipment management, water chemistry calculations, GIS/satellite map layers, maintenance, storage/inventory, tasks, reports, and cleaner fish management. Routes under `/sites/*`.

## Directory Structure

```
web/modules/farm-module/src/
  main.tsx
  pages/
    FarmListPage.tsx            # List of all farms/sites
    FarmDetailPage.tsx          # Farm detail view
    FarmFormPage.tsx            # Create/edit farm
    SensorDashboardPage.tsx     # Embedded sensor dashboard for a farm
    setup/
      tabs/
        SitesTab.tsx            # Sites management
        SpeciesTab.tsx          # Species management
        SuppliersTab.tsx        # Supplier management
        EquipmentTab.tsx        # Equipment with feeder calibrations
      index.ts
    tanks/
      columns.tsx               # TanStack table column defs
      types.ts
      useColumnVisibility.ts
      ColumnVisibilityMenu.tsx
      components/
        QuickActionsPanel.tsx
        FishTypeSelector.tsx
        CleanerBatchSelector.tsx
        TankChartsSection.tsx
        ChartSettingsModal.tsx
        CompactSummaryStats.tsx
    production/
      tabs/
        BatchInputTab.tsx
        GrowthTab.tsx
      components/
        DocumentUploadSection.tsx
        MortalityModal.tsx
        CullModal.tsx
        TransferModal.tsx
    feeding/
      DailyFeedingDashboard.tsx  # Daily feeding execution tracking
      FeedingPage.tsx            # Feeding program management
      components/
        DailyFeedPlan.tsx        # 14-day plan table
        GrowthForecastChart.tsx  # SGR-based growth chart
        FeedStockPanel.tsx       # Stock level alerts
        FCRAnalysis.tsx          # FCR analysis component
        PlannedVsActualSection.tsx
        RecordFeedingModal.tsx   # Modal to record actual feeding
    cleaner-fish/
      CleanerFishPage.tsx
      types.ts
      components/
        CleanerBatchList.tsx
        CreateBatchModal.tsx
        DeployModal.tsx
        TransferModal.tsx
        MortalityModal.tsx
        RemoveModal.tsx
        TankCleanerFishCard.tsx
    maintenance/
      MaintenanceSchedulesPage.tsx
      SparePartsPage.tsx
      WorkOrdersPage.tsx
    water-chemistry/
      engine/
        water-quality.ts        # Water quality calculations
        co2-calc.ts             # CO2 calculation engine
        reagents.ts
        deffeyes-data.ts
        ammonia-calc.ts
        types.ts
    reports/
      types/reports.types.ts
      hooks/  (useDeadlines, useThresholdCheck, useReportDraft)
      components/ (ReportCard, ReportStatusBadge, DeadlineIndicator, ReportWizard, WizardStepIndicator)
      mock/   (biomassData, escapeReportData, slaughterData, seaLiceData, cleanerFishData, smoltData, welfareEventData, diseaseOutbreakData)
    storage/
      types/storage.types.ts
      mock/   (feedStock, chemicals, consumables, storageLocations, stockMovements, purchaseOrders, inventoryCount)
    tasks/
      types/task.types.ts
      mock/   (tasks, recurring, autoRules, stats)
  components/
    map/
      SentinelTileLayer.tsx     # Sentinel-2 satellite imagery tile layer
      CMEMSTileLayer.tsx        # Copernicus Marine CMEMS tile layer
      AOILayer.tsx              # Area of Interest polygon layer
      AOIDrawingControls.tsx    # Drawing tools for AOI
      GeomanController.tsx      # Leaflet-Geoman draw controller
      DateRangePicker.tsx
      SatelliteLayerControl.tsx
      WaterQualityLegend.tsx
      PointDataPopup.tsx        # Water quality point data popup
      PointDataPanel.tsx        # Side panel for point data
      AOIAnalysisPanel.tsx      # AOI statistics panel
    DeadlineWidget/
      DeadlineWidget.tsx        # Regulatory deadline countdown widget
    feeding/index.ts
  hooks/
    useFeeding.ts               # Growth simulation + feed forecast (React Query)
    useTanks.ts
    useSites.ts
    useBatches.ts
    useSpecies.ts
    useEquipment.ts
    useMaintenance.ts
    useHealthEvents.ts
    useCleanerFish.ts
    useFeeds.ts
    useChemicals.ts
    useConsumables.ts
    useStorageLocations.ts
    useStorageInventory.ts
    usePurchaseOrders.ts
    useSystems.ts
    useDepartments.ts
    useSuppliers.ts
    useWorkers.ts
    useTenantUsers.ts
    useFileUpload.ts
    useWaterQuality.ts
    useMapPointQuery.ts
    useAOIDrawing.ts
    useSentinelHub.ts
    useSentinelTiles.ts
    useWeather.ts
    useDailyFeedingExecution.ts  # Daily feeding execution CRUD
    useFeederCalibration.ts      # Feeder calibration save/load
    useTankFeeders.ts
  services/
    tank.service.ts
    pointQueryService.ts         # Copernicus point query REST calls
    sentinelTileService.ts       # Sentinel Hub tile requests
    sentinelHubService.ts
    cmemsService.ts              # CMEMS Marine data service
  graphql/
    feedingProgram.queries.ts
    feedingProgram.mutations.ts
    index.ts
```

## Pages / Components

### DailyFeedingDashboard (`/sites/feeding`)
Main page for daily feeding operations:
- Date picker to select feeding date
- 4 summary cards: Total Feed (kg), Completed tanks, Pending tanks, Transition tanks
- Progress bar (% of tanks fed)
- Paginated table (20 per page) of `DailyFeedingExecution` records
- Click row to open `RecordFeedingModal` for entering actual kg
- `useDailyFeedingExecutions(date)` fetches data; `useSkipDailyFeeding(date)` for skip mutations
- Statuses: `PENDING`, `COMPLETED`, `SKIPPED`; transition days shown with orange left border

### FeedingPage (`/sites/feeding/programs`)
Feeding program management: SGR-based growth simulation, 14-day feed plan, feed stock alerts, FCR analysis.

Key hooks used:
- `useGrowthSimulation(input)` — queries `growthSimulation` GraphQL
- `useFeedConsumptionForecast(input)` — queries `feedConsumptionForecast` GraphQL
- `useActiveTanks()` — queries `activeTanks` for tank selection

### Map Components
Leaflet-based map with:
- Sentinel-2 satellite imagery via Sentinel Hub API
- CMEMS Marine environmental data layers
- Leaflet-Geoman for AOI drawing
- Point-click water quality queries

### Reports Page
Report wizard with multiple report types: biomass, escape, slaughter, sea lice, cleaner fish, smolt, welfare events, disease outbreak. Currently uses mock data — not wired to backend.

## State Management

- **@tanstack/react-query** for all data fetching (every hook uses `useQuery` or `useMutation`)
- No Zustand store in this module
- Query keys follow pattern: `['feeding', 'growth-simulation', input]`, `['tanks', tenantId]`, etc.
- `schemaName` computed as `tenant_${tenantId.replace(/-/g,'').substring(0,8).toLowerCase()}` — passed to all farm queries

## GraphQL Operations

Key feeding queries:
```graphql
query GrowthSimulation($tenantId: ID!, $schemaName: String!, $input: GrowthSimulationInput!) { growthSimulation { projections { ... } summary { ... } feedRequirements { ... } } }
query FeedConsumptionForecast($tenantId: ID!, $schemaName: String!, $input: FeedForecastInput) { feedConsumptionForecast { byFeedType { ... } alerts { ... } } }
query ActiveTanks($tenantId: ID!, $schemaName: String!) { activeTanks { tankId tankName batchId fishCount avgWeightG biomassKg } }
query ProjectHarvestDate($currentWeightG, $targetWeightG, $sgr, $startDate) { projectHarvestDate }
query EstimateSGR($species, $temperature) { estimateSGR }
```

Daily feeding execution queries (in `useDailyFeedingExecution.ts`):
- `DailyFeedingExecutions(date)` — list by date
- `RecordDailyFeeding(executionId, actualKg, ...)` mutation
- `SkipDailyFeeding(executionId, reason)` mutation

## Routing

```
/sites                  -> FarmListPage
/sites/new              -> FarmFormPage
/sites/map              -> Map view
/sites/setup            -> Setup tabs (Sites, Species, Equipment, Suppliers)
/sites/tanks            -> Tank management
/sites/feeding          -> DailyFeedingDashboard
/sites/feeding/programs -> FeedingPage (growth simulation)
/sites/water-chemistry  -> Water chemistry calculator
/sites/storage          -> Storage & Stock
/sites/tasks            -> Task management
/sites/health           -> Health Events
/sites/harvest          -> Harvest records
/sites/reports          -> Report wizard
/sites/company          -> Company/regulatory info
```

## Key Dependencies

- `@tanstack/react-query` — data fetching
- `@aquaculture/shared-ui` — graphqlClient, useAuth, shared components
- `leaflet` + `react-leaflet` — mapping
- `leaflet-geoman` — AOI drawing
- Tailwind CSS
- Vite + Module Federation

## Known Gotchas

- `schemaName` must be derived as `tenant_${tenantId.replace(/-/g,'').substring(0,8).toLowerCase()}` and passed to all farm-service queries that need it. Missing or wrong schema name returns 0 results silently.
- `useAuth()` from `@aquaculture/shared-ui` (not `useAuthContext`) is used in farm hooks — it returns `{ token, tenantId }`.
- Reports page uses entirely mock data — all `reports/mock/` files. Not connected to backend.
- Storage and Tasks pages also use mock data.
- `EquipmentTab` has feeder calibration section using newly added `useFeederCalibration` and `useTankFeeders` hooks.
- Map satellite layers require Sentinel Hub credentials (not stored in this repo — env vars).
- `formatDate` in `useFeeding.ts` formats dates in Turkish locale (`tr-TR`).
- Water chemistry engine runs entirely client-side; no backend calls.

## Related Backend Services

- **farm-service** (port 3002 dev) — main data source for all farm entities
- **sensor-service** (port 3003 dev) — SensorDashboardPage embeds sensor data
- **gateway-api** (port 3000) — all GraphQL requests
