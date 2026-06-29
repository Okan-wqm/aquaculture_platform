<!-- Generated 2026-06-29 by a multi-agent workflow (farm-data-flow-map): 1 architecture map + 38 per-hook DB->frontend traces (data-readback-auditor) + adversarial verification of every HIGH/CRITICAL claim (tenant-isolation-auditor) + synthesis (farm-expert). Grounded in live prod-droplet evidence (tenant_7f6b08ab90e246d3 row counts, RLS policy count, default search_path, deployed image SHA). 65 agents, ~5.5M tokens. -->

# Farm-Module Data-Flow & the Intermittent "Data Appears Then Disappears" Bug

**Scope:** `web/modules/farm-module/**` read hooks → gateway → `apps/farm-service/**` read path → `tenant_<uuid>` schema. **Reported surface:** `https://app.suderra.com/sites/setup/sites` (sub-tabs intermittently show/hide DB data). **Live runtime:** `farm-service:2de19d36` = commit **#658** (built 2026-06-28T08:17Z), which **predates #696** (the FARM-HIGH-060 fail-closed read boundary, merged 21:35Z). Tenant under inspection: `tenant_7f6b08ab90e246d3`.

---

## 1. Executive Summary — Root Cause

The intermittent empty-data bug is **pooled-connection tenant-context roulette**, made silent by Row-Level Security and made invisible by fail-open reads.

Every farm read rides one pooled `pg` connection whose tenant routing is established by **four stacked mechanisms** (`libs/backend-common/src/database/tenant-connection-bootstrap.service.ts`, `.../rls/rls-connection-bootstrap.service.ts`, `.../rls/apply-tenant-rls.helper.ts`, `.../tenant-transaction.ts`). Two are pool-checkout patches that re-derive the tenant from the AsyncLocalStorage (ALS) `RequestContext` at **every** `pool.connect`:

- **(a) search_path** → `tenant_<uuid>, farm, public` when the ALS frame carries a tenant; otherwise it **falls back to `farm, public`** (`tenant-connection-bootstrap.service.ts:139-145`).
- **(b) RLS GUC** → `set_config('app.current_tenant', <uuid>, false)` only if `readRlsContext()` finds a UUID; otherwise the GUC is left **empty** (`rls-connection-bootstrap.service.ts:240-258`).

The RLS predicate is deliberately fail-closed-to-empty:

```
current_setting('app.bypass_rls', true) = 'on'
OR "<tenant_col>" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
```

(`apply-tenant-rls.helper.ts:271-280`). An **unset GUC → empty string → `NULL` → predicate UNKNOWN → zero rows, no error.** A search_path that fell back to `farm` queries the **empty source schema** (`farm.sites = 0`, while `tenant.sites = 1`). Either path returns **HTTP 200 with `items:[]`** — indistinguishable from a legitimately empty table.

**Why intermittent:** each of the 10 `/sites/setup` tabs is a **separate GraphQL operation → separate gateway→subgraph hop → separate pool checkout**. Per-checkout the tenant context is re-derived from the ALS frame. A checkout that retains the verified tenant returns the row(s); a checkout whose ALS frame was lost across an async hop — or a SUPER_ADMIN act-as session whose `effectiveTenantId` resolved null — degrades to `search_path=farm` (empty) or an unset GUC (RLS deny-all). Data-bearing tabs therefore **flicker between their real count and 0**, while genuinely-empty tabs stay blank for an entirely different, legitimate reason. The gateway middleware docblock names this exact scenario: "data sometimes loads, sometimes not" (`apps/gateway-api/src/middleware/effective-tenant.middleware.ts:11-13`).

**Two compounding factors:**

1. **The deployed image predates the fix.** #696 added `runInTenantRead` (`tenant-transaction.ts:251-344`), a transaction-local boundary that pins search_path with `is_local=true`, **owns** the `app.current_tenant` GUC transaction-locally, then reads back `current_schema()` + the GUC and **throws `TenantContextError{SCHEMA_MISMATCH|RLS_MISMATCH}`** (`:183-244`) on any divergence — converting silent-empty into a loud error. The live #658 binary does not run this assertion, so production silently empties.

2. **A residue of raw reads never entered the boundary at all.** Several domains read via raw `@InjectRepository` directly in resolvers/services, bypassing the CQRS query bus. These are invisible to the build-time guard `tests/invariants/farm-read-boundary-ssot.spec.ts` (which only scans `IQueryHandler` classes) and were **never migrated** — they stay fail-open even after #696 deploys. This is the systemic tail.

**Net for the reported `/sites/setup` symptom:** the SitesTab/DepartmentsTab/SystemsTab/ChemicalsTab handlers are **already fail-closed on `main`** (they use `runInTenantRead`). Their live flicker is purely the **deployment gap** — fixed by shipping the post-#696 image. The deeper, deploy-independent risk lives in the never-migrated domains (task, water-quality, harvest, maintenance, fish-health, feeding analytics, cleaner-fish, regulatory). The front-end cache layer is **not** the cause: keys are tenant-scoped+epoch'd (`createTenantQueryKey`) and invalidations are epoch-less (`createTenantInvalidationKey`) per FARM-HIGH-082.

---

## 2. Canonical Data-Flow Pipeline

```
React hook (useSites …)                     web/modules/farm-module/src/hooks/*.ts
  └─ useQuery key = createTenantQueryKey(tenantId, …, {sessionEpoch})   ← tenant-scoped cache
       enabled: !!token && !!tenantId        ← guards ['tenant', null, …] (some hooks omit !!tenantId)
  └─ graphqlClient.request(QUERY, vars)       web/shared-ui/src/utils/api-client.ts:517-595
       Authorization: Bearer <token>          :562-564
       X-Tenant-Id: getTenantId()             :567-570   ← INFORMATIONAL ONLY
        │
        ▼  POST /graphql
GATEWAY  apps/gateway-api
  EffectiveTenantMiddleware                   middleware/effective-tenant.middleware.ts:130-202
     regular user → effectiveTenantId = JWT tenantId; divergent act-as → 403
     SUPER_ADMIN  → act-as target only after UUID + tenant-ACTIVE + MFA step-up
  AuthenticatedDataSource.willSendRequest     federation/authenticated-data-source.ts:175-258
     x-tenant-id = effectiveTenantId ?? user.tenantId        :203-205
     x-verified-user-assertion (HMAC signs effectiveTenantId) :244
  withServiceIdentitySigning                  :136-173  HMAC over wire bytes incl. tenantId
        │
        ▼  gateway → farm subgraph hop  (NEW pool checkout downstream)
FARM SUBGRAPH  apps/farm-service
  Middleware chain                            app.module.ts:541-551
     VerifiedUserAssertionMiddleware → req.tenantId = assertion.effectiveTenantId   verified-user-assertion.middleware.ts:51-59
     RequestContextMiddleware       → ALS frame, reads req.tenantId FIRST           request-context.middleware.ts:62-88
     TenantSchemaMiddleware         → derive tenant_<uuid>, re-run in fresh ALS      tenant-schema.middleware.ts:52-92
  Resolver  @UseGuards(TenantGuard) @CurrentTenant() tenantId   ← server-derived, never browser-trusted
        │
        ├── (GOOD PATH) → CQRS QueryBus → IQueryHandler → runInTenantRead(dataSource,'farm',tenantId,…)
        │       pins search_path is_local + asserts current_schema()/GUC → THROWS on mismatch (fail-closed)
        │
        └── (RAW PATH)  → resolver/service calls this.repo.find({where:{tenantId}}) directly
                routing depends ONLY on pool-checkout (a)+(b) → silent-empty on context loss
        │
        ▼  pool.connect()  →  patches (a) search_path  +  (b) app.current_tenant GUC  re-asserted
TENANT SCHEMA  tenant_7f6b08ab90e246d3.*   (RLS USING: NULLIF(GUC,'')::uuid → empty on unset)
```

**Tenant-context establishment / break points:**

| Point | Establishes | Breaks when |
|---|---|---|
| Gateway `EffectiveTenantMiddleware` | `effectiveTenantId` from JWT/act-as | SUPER_ADMIN with no/unresolved act-as → null |
| HMAC `x-verified-user-assertion` | binds tenantId in flight | (cannot be swapped — fail-closed) |
| `RequestContextMiddleware` ALS frame | `getRequestContext().tenantId` | lost across an async hop / non-HTTP path |
| Pool patch (a) search_path | `tenant_<uuid>,farm,public` | empty ALS frame → falls to `farm,public` (empty) |
| Pool patch (b) RLS GUC | `app.current_tenant` | no UUID in ctx → `''` → RLS deny-all |
| `runInTenantRead` (c) | tx-local pin + read-back assertion | **absent in #658**; absent in never-migrated raw reads |

The decisive subtlety: `@CurrentTenant()` (`libs/backend-common/src/decorators/tenant.decorator.ts:42-56`) reads `req.user.tenantId` (the **request object**), which correctly scopes the `WHERE tenantId` column predicate. The pool patches read the **ALS frame**. These are **two distinct stores**; a correct `WHERE` clause does **not** guarantee the connection's search_path/GUC is correct. That is precisely why a column-filtered raw read can still silent-empty.

---

## 3. Per-Query Matrix (every traced hook)

Read mechanism legend: **boundary** = `runInTenantRead` (fail-closed on main); **raw** = `@InjectRepository`/resolver-inline (fail-open on main+live); **deploy-lag** = boundary on main but raw in live #658. `★` = `/sites/setup` tab. `◇` = water-chemistry/equipment sub-surface.

| Hook | Query/Operation | Surfaces | Read mechanism | Tenant ctx | Silent-empty | Status |
|---|---|---|---|---|---|---|
| useSites ★ | Sites / Site / SiteDeletePreview / SiteContacts | SitesTab + dropdowns | boundary `list-sites.handler.ts:34-69`, `get-site.handler.ts:26-31` | fail-closed (main) / pool (live) | LOW (deploy-lag) | AT-RISK |
| useSites ★ | CreateSite/UpdateSite/DeleteSite/UpsertSiteContacts | SiteFormModal | command | n/a | — (region/siteManager/totalArea read-model drift) | — |
| useDepartments ★ | departments / departmentsBySite / department / departmentDeletePreview / site(field) | DepartmentsTab, Systems/Equipment dropdowns | boundary `list-departments.handler.ts:28`, `get-department.handler.ts:31` | fail-closed (main) / pool (live) | LOW (deploy-lag); currentLoad/manager DTO drift | AT-RISK |
| useSystems ★ | Systems / SystemsBySite / SystemsByDepartment / RootSystems / ChildSystems / System / SystemDeletePreview | SystemsTab, EquipmentTab, WQ tabs | boundary `list-systems.handler.ts:28`, `get-system.handler.ts:22` | fail-closed (main) / pool (live) | LOW (deploy-lag); site/dept ResolveField swallow err `system.resolver.ts:245-266` | AT-RISK |
| useChemicals ★ | Chemicals / Chemical | ChemicalsTab + 3 storage modals | boundary `list-chemicals.handler.ts:28-29`, `get-chemical.handler.ts:22-33` | fail-closed (main) / pool (live) | LOW (deploy-lag) | AT-RISK |
| useChemicals ★ | ChemicalTypes | category dropdown | **raw @SkipTenantGuard** `chemical.resolver.ts:228-236` | global ref (no tenantId col) | LOW; mock fallback masks empty `ChemicalsTab.tsx:417` | AT-RISK |
| useConsumables ★ | consumables / consumable | ConsumablesTab + storage modals | boundary `list-consumables.handler.ts:25`, `get-consumable.handler.ts:20` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag; tenant rows=0) | AT-RISK |
| useFeeds ★ | Feeds / Feed | FeedsTab + 8 dropdowns | boundary `list-feeds.handler.ts:30`, `get-feed.handler.ts:23-33` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag; rows=0) | AT-RISK |
| useFeeds ★ | FeedTypes | type dropdown | **raw @SkipTenantGuard** `feed.resolver.ts:189-197` | search_path-routed, no RLS col | MEDIUM; **mock FALLBACK_FEED_TYPES** masks empty `FeedsTab.tsx:233` | AT-RISK |
| useFeeds ★ | FeedSuppliers | supplier dropdown | boundary (ListSuppliersQuery) | fail-closed (main) | LOW | AT-RISK |
| useSuppliers ★ | Suppliers / Supplier / SupplierSites | SuppliersTab + 6 dropdowns | boundary `list-suppliers.handler.ts:28`, `get-supplier.handler.ts:23` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag; rows=0); paymentTerms/address readback gaps | AT-RISK |
| useSuppliers ★ | SupplierTypes | (unused) | **raw @SkipTenantGuard** `supplier.resolver.ts:195-203` | global ref | LOW | AT-RISK |
| useWorkers ★ | Workers | WorkersTab | boundary `list-workers.handler.ts:19-22` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag; rows=0, latent) | AT-RISK |
| useEquipment ★ | EquipmentList / EquipmentTypes | EquipmentTab + feeding/WQ dropdowns | **raw allowlisted** `list-equipment.handler.ts:62-70,145`, `get-equipment-types.handler.ts:25-28` | pool (main+live) | MEDIUM (raw on main; rows=0) | AT-RISK |
| useEquipment ★ | EquipmentDeletePreview | delete dialog | `tenantManagerRepo` (no assert) `get-equipment-delete-preview.handler.ts:38-40` | pool | MEDIUM | AT-RISK |
| useSpecies ★ | speciesList / species / activeSpecies | SpeciesTab, batch/protocol dropdowns | boundary `list-species.handler.ts:31`, `get-species.handler.ts:26` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag; rows=0); batch dropdown limit-20 cap | AT-RISK |
| useStorageLocations | StorageLocations / StorageLocation | StorageLocationsTab, dropdowns | boundary `list-storage-locations.handler.ts:25`, `get-storage-location.handler.ts:20` | fail-closed (main) / pool (live) | LOW (deploy-lag); pagination cap-100; m3/m³ glyph drift | AT-RISK |
| useStorageInventory | StorageInventory / StorageOverview / StockMovements / TraceLot | StoragePage, OverviewTab, stock tabs | boundary `get-storage-inventory.handler.ts:23`, `get-storage-overview.handler.ts:43` | fail-closed (main) / pool (live) | LOW (deploy-lag); **itemName/locationName always undefined** `storage-inventory.response.ts:42-47` | AT-RISK |
| usePurchaseOrders | PurchaseOrders / PurchaseOrder / PendingDeliveries | PurchaseOrdersTab, OverviewTab | boundary `list-purchase-orders.handler.ts:20`, `get-purchase-order.handler.ts:18` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag); OverviewTab swallows error `OverviewTab.tsx:37` | AT-RISK |
| useInventoryCounts | inventoryCounts / inventoryCount | InventoryCountTab/Modal | boundary `list-inventory-counts.handler.ts:27`, `get-inventory-count.handler.ts:24` | fail-closed (main) | **N/A — hard contract break** | **BROKEN** |
| useBatches | Batches / Batch / AvailableTanks / GenerateBatchNumber | BatchInputTab, BatchDetailPage | boundary `list-batches.handler.ts:30`, `get-batch.handler.ts:30` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag) | AT-RISK |
| useBatchFeedAssignments | GetBatchFeedAssignment | BatchFeedingTab | **raw resolver + dataloader** `batch-feed-assignment.resolver.ts:75-77` | pool (main+live) | HIGH | AT-RISK |
| useGrowth | growthAnalysis | GrowthTab overview | boundary handler, **shape ≠ GraphQL type, no mapper** `growth.resolver.ts:462-470` | n/a | **N/A — always errors** | **BROKEN** |
| useGrowth | growthMeasurements / batchGrowthHistory / latestGrowthMeasurement | GrowthTab table/chart | boundary `get-growth-measurements.handler.ts:29` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag) | AT-RISK |
| useGrowth | growthMeasurement(id) | (unused) | **raw resolver** `growth.resolver.ts:399-419` | pool | MEDIUM | — |
| useCleanerFish | CleanerFishSpecies / CleanerFishBatches / TankCleanerFish | CleanerFishPage, TanksPage | **raw resolver** `cleaner-fish.resolver.ts:405-455` | pool (main+live) | MEDIUM | AT-RISK |
| useDailyFeedingExecution | dailyFeedingExecutions | PlannedVsActualSection | **raw resolver queryBuilder** `feeding-program.resolver.ts:513-529` | pool (main+live) | HIGH; optimistic-key mismatch `useDailyFeedingExecution.ts:518 vs 453` | AT-RISK |
| useFeeding | FeedConsumptionForecast / GrowthSimulation / ActiveTanks | FeedingPage, GrowthForecastChart | **raw services** `feed-consumption-forecast.service.ts:304-385`, `growth-simulator.service.ts:363-475` | pool (main+live) | MEDIUM; FeedingPage renders empty as "All good" | AT-RISK |
| useFeeding | ProjectHarvestDate / EstimateSGR | (unused) | pure compute (no DB) | n/a | none | — |
| useFeedingProtocols | feedingProtocols / feedingProtocol / bySpecies / default | ProtocolsTab | boundary `list-feeding-protocols.handler.ts:28`, `get-feeding-protocol.handler.ts:22` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag) | AT-RISK |
| useFeedingRecords | FeedingRecords / DailyFeedingPlan / FeedingSummary / FeedInventory | feeding tabs | boundary `get-feeding-records.handler.ts:29` etc. | fail-closed (main) / pool (live) | HIGH (deploy-lag, live fail-open) | AT-RISK |
| useFeedingRecords | FeedingRecord(id) | (dormant — no consumer) | **raw resolver** `feeding.resolver.ts:930-940` | pool (main+live) | MEDIUM | — |
| useEquipmentParameters ◇ | equipmentParameters | RecordTab, BulkRecordTab | boundary `get-equipment-params.handler.ts:37` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag); UI conflates error/empty | AT-RISK |
| useParamEquipmentMapping ◇ | parameterEquipmentMappings / equipmentParameters | EquipmentMappingPanel, ParameterConfigManager | boundary `list-param-equipment.handler.ts:49` | fail-closed (main) / pool (live) | MEDIUM (FE `enabled` misplaced `useParamEquipmentMapping.ts:166`; badge swallow) | AT-RISK |
| useParameterConfigs ◇ | parameterConfigs / parameterConfig / byCode | ParameterConfigManager, HistoryTab | boundary `list-parameter-configs.handler.ts:49` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag); **HistoryTab FALLBACK_COLUMNS masks** `HistoryTab.tsx:166-172` | AT-RISK |
| useParameterConfigs ◇ | parameterTemplates | TemplatePickerModal | static array (no DB) `list-parameter-templates.handler.ts:33-44` | n/a | none | — |
| useWaterQuality ◇ | waterQualityMeasurements / waterQuality / latest / critical / chart / statistics / chartBySystem / statisticsBySystem | HistoryTab, RecordTab | **raw services, CQRS-bypassed** `water-quality.service.ts:463-826`, `water-quality.resolver.ts:78-183` | pool (main+live) | HIGH (life-safety alert panel) | AT-RISK |
| useFeederCalibration ◇ | FeederCalibrations | FeederCalibrationSection (Equipment edit) | boundary `list-feeder-calibrations.handler.ts:22-27` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag; latent, equipment=0) | AT-RISK |
| useSubEquipment ◇ | subEquipmentByParent | SubEquipmentSection (Equipment tab) | boundary `list-sub-equipment.handler.ts:28` | fail-closed (main) / pool (live) | LOW (deploy-lag); enum-status drift | AT-RISK |
| useSubEquipment ◇ | subEquipmentTypes | type dropdown | **raw @SkipTenantGuard** `sub-equipment.resolver.ts:117-127` | global ref (no tenantId col) | LOW | AT-RISK |
| useTankFeeders | subEquipmentByParent | RecordFeedingModal feeder dropdown | boundary `list-sub-equipment.handler.ts:28` | fail-closed (main) / pool (live) | MEDIUM (deploy-lag; latent); narrowing drop-out + status enum never read | AT-RISK |
| useTanks | EquipmentWithBatches (+ batchMetrics fields) | TanksPage, analytics, reports | **raw allowlisted** `list-equipment.handler.ts:145-310` | pool (main+live) | MEDIUM (rows=0; batchMetrics N extra checkouts) | AT-RISK |
| useTasks | Tasks / TaskStats | TasksPage tabs | **raw service** `task.service.ts:322-363, 802-822` | pool (main+live) | HIGH; error swallowed `TasksPage.tsx:114-126`; completed cap-50 | AT-RISK |
| useAutoRules | AutoRules | TasksPage auto-rules tab | **raw service** `auto-rule.service.ts:36-39` | pool (main+live) | HIGH; full UI error swallow | AT-RISK |
| useRecurringTemplates | recurringTemplates | TasksPage recurring tab | **raw service** `recurring-task.service.ts:52-57` | pool (main+live) | MEDIUM; error swallowed | AT-RISK |
| useHarvestPlans | harvestPlans / harvestPlanStats / harvestPlan / byCode / byBatch / upcoming / overdue | HarvestPlansPage | **raw service, CQRS-bypassed** `harvest-plan.service.ts:365-496` | pool (main+live) | HIGH; no error UI | AT-RISK |
| useHealthEvents | HealthEvents / HealthEventStats / HealthEvent / byBatch / critical / overdue | HealthEventsPage | **raw service** `health-event.service.ts:102-215` | pool (main+live) | MEDIUM | AT-RISK |
| useMaintenance | workOrders / workOrder / statistics / maintenanceSchedules / schedule / upcoming / alerts / spareParts / sparePart / lowStock / stockSummary | 3 maintenance pages | **raw services, CQRS-bypassed** `work-order.service.ts:253-765`, `maintenance-schedule.service.ts:303-466`, `spare-part.service.ts:215-567` | pool (main+live) | MEDIUM | AT-RISK |
| useRegulatory | RegulatorySettings / ConfigurationStatus / MattilsynetStatus / RegulatoryHealth (DB parts) | reports tabs | **raw service** `regulatory-settings.service.ts:71-81` | pool (main+live) | MEDIUM; broken invalidation `useRegulatory.ts:492-497`; mock report-history | AT-RISK |
| useRegulatory | MaskinportenStatus | reports | static config (no DB) `maskinporten.service.ts:488-502` | n/a | none (always `configured:false`) | — |
| useTenantUsers | TenantUsers (auth) | TasksPage assignee picker | explicit-WHERE queryBuilder `tenant.service.ts:229-230` (auth, platform-level) | fail-closed (JWT WHERE) | tenant-safe | AT-RISK |
| useTenantUsers | Workers (farm) | assignee picker | boundary `list-workers.handler.ts:19` | fail-closed (main) / pool (live) | MEDIUM — **stale cross-tenant readback** (raw `useState`, `[token]` dep, no epoch) | AT-RISK |
| *(all hooks)* | Create/Update/Delete/… mutations | forms/modals | command bus | n/a | invalidate via epoch-less `createTenantInvalidationKey` (correct, FARM-HIGH-082) | — |

---

## 4. Ranked AT-RISK / BROKEN (highest risk first)

### Tier 0 — BROKEN (deterministic failure on every request, not tenant-context)

1. **useGrowth → growthAnalysis** — Resolver returns the queryBus result with **no mapper**; handler emits a flat `GrowthAnalysisResult` (`batchNumber`, `growthTrend`) but the GraphQL `GrowthAnalysisResponse` requires non-null nested `currentMetrics`/`trend`/`projection`/`measurementHistory` + `batchCode`/`analysisDate`. Non-null serialization error fires every call → graphqlClient throws → Growth Overview always shows "Analiz verisi yüklenemedi." Evidence: `growth.resolver.ts:462-470,357-387`; `get-growth-analysis.handler.ts:160-204`; `api-client.ts:639-668`. **Independent of tenant context, image version, or rows.**

2. **useInventoryCounts → all 6 ops** — `COUNT_FIELDS` selects `locationName`, a field **absent from `InventoryCountResponse`** (`inventory-count.response.ts:45-94`, no column/ResolveField). GraphQL validation rejects every read **and** write before execution. The whole inventory-count feature is non-functional. The parity invariant `farm-graphql-fe-be-parity.spec.ts` only checks root fields, so this nested-selection drift is invisible. Evidence: `useInventoryCounts.ts:129,153-209`; `InventoryCountTab.tsx:134-142`.

### Tier 1 — HIGH (fail-open raw reads that persist on `main` AND live; tenant rows can vanish silently)

3. **useTasks → Tasks, TaskStats** — `TaskService.findAll` (`task.service.ts:322-363`) and `getStats` (`:802-822`, unqualified `FROM tasks`) are raw `@InjectRepository` reads; grep of `apps/farm-service/src/task` shows **zero** boundary helpers. `TasksPage.tsx:114-126` never reads `error` → blank tabs with no diagnostic. Empty-200 overwrites cache → appear/disappear.

4. **useAutoRules → AutoRules** — `Auto​RuleService.findAll` raw `@InjectRepository(AutoRule).find({where:{tenantId}})` (`auto-rule.service.ts:36-39`); whole task module fail-open. Total UI error swallow (`AutoRulesTab.tsx:31-34`, `TasksPage.tsx:133-136,200`).

5. **useWaterQuality → 8 reads** — `WaterQualityService` raw repository reads (`water-quality.service.ts:463,481,535,557,582,706,813`); resolver calls service directly, **bypassing the CQRS bus** (`water-quality.resolver.ts:78-183`). Feeds the **life-safety `criticalWaterQuality` alert panel**. Chart/stat/recent-entries surfaces render read-failure identically to empty.

6. **useHarvestPlans → 7 reads** — `HarvestPlanService` raw `@InjectRepository` (`harvest-plan.service.ts:56-58,365-496`), resolver-direct (no QueryBus), invisible to the read-boundary invariant. `HarvestPlansPage.tsx:2417-2423` coalesces to `?? []`/zeroed stats with no error read.

7. **useDailyFeedingExecution → dailyFeedingExecutions** — Raw `createQueryBuilder().getMany()` in the resolver (`feeding-program.resolver.ts:513-529`); `catch` returns `[]` and the `TenantContextError` re-throw is dead because the path never asserts. Plus optimistic-update key mismatch (`useDailyFeedingExecution.ts:518` bare key vs `:453` `createTenantQueryKey`).

8. **useBatchFeedAssignments → GetBatchFeedAssignment** — Raw `feedAssignmentRepo.findOne` (`batch-feed-assignment.resolver.ts:75-77`) and same raw `.find` in the batch-list dataloader (`batch-feed-assignment.dataloader.ts:34-43`). Null renders as "henüz yem ataması yapılmamış", indistinguishable from genuine emptiness.

9. **useFeedingRecords → list/plan/summary/inventory** — HIGH driven by the **deployment gap** (the 4 list handlers are `runInTenantRead` on main, raw in #658), **plus** the persistent raw `feedingRecord(id)` resolver read (`feeding.resolver.ts:930-940`, currently dormant). FE is stale-on-error not stale-on-empty (`list-view-state.ts:15-17`), so a silent-empty paints "No feeding records found".

### Tier 2 — MEDIUM (raw reads biased to empty, or deploy-lag with live exposure)

10. **useCleanerFish** — raw resolver reads `cleaner-fish.resolver.ts:405-455` (mutations correctly use commandBus; reads don't).
11. **useFeeding** — raw services `feed-consumption-forecast.service.ts:304-385`, `growth-simulator.service.ts:363-475`; FeedingPage renders empty forecast as "All good".
12. **useHealthEvents** — raw `HealthEventService` `health-event.service.ts:102-215`.
13. **useMaintenance** — raw `WorkOrderService`/`MaintenanceScheduleService`/`SparePartService`, CQRS-bypassed; op-name drift `recordStockMovement`→`recordSparePartStockMovement`.
14. **useRegulatory** — raw `regulatory-settings.service.ts:71-81` (dead `TenantContextError` catch); broken `invalidateAllRegulatoryQueries` predicate (`useRegulatory.ts:492-497`); mock report-history lists.
15. **useRecurringTemplates** — raw `recurring-task.service.ts:52-57`; error swallowed.
16. **useEquipment / useTanks** — `list-equipment.handler.ts` is on the **raw-read allowlist** (`farm-read-boundary-ssot.spec.ts:41,43`), fail-open on main too; biases to empty (`equipment.tenantId=:tenantId` WHERE + RLS deny). For this tenant `equipment=0`.
17. **useTenantUsers** — raw `useState`/`useEffect`, dep `[token]` only, **no `createTenantQueryKey`/epoch and no `onTenantChange`** → on a SUPER_ADMIN tenant switch that doesn't rotate the token, the prior tenant's user identities (PII) stay rendered (`useTenantUsers.ts:46,93,102`). `Promise.allSettled` coerces role-rejections to `[]`.
18. **Deploy-lag MEDIUM (fail-closed on main, raw in #658):** useBatches, useConsumables, useSpecies, useSuppliers, useFeeds, useFeedingProtocols, usePurchaseOrders, useEquipmentParameters, useParameterConfigs, useParamEquipmentMapping, useFeederCalibration, useTankFeeders.

### Tier 3 — LOW (fail-closed on main; residual is deployment-lag and/or non-tenant correctness)

19. **useSites, useDepartments, useChemicals, useSystems, useStorageInventory, useStorageLocations, useSubEquipment** — all four reads route through `runInTenantRead` on main; the live flicker is purely the **#658 deployment gap**. Residuals are non-tenant: Site `region/siteManager/totalArea` read-model drift; Department `currentLoad/manager` drift; StorageInventory `itemName/locationName` always undefined; SubEquipment status enum drift.

---

## 5. Reported Surface Deep-Dive — `/sites/setup` Sub-Tabs

Runtime row counts in `tenant_7f6b08ab90e246d3`: **sites=1, departments=1, systems=1, chemicals=1** (data-bearing) — **suppliers=0, equipment=0, workers=0, feeds=0, consumables=0, species=0** (genuinely empty).

| Tab | Hook | Rows? | What the user sees & why |
|---|---|---|---|
| **Sites** | useSites | **1** | **Flickers 1↔0.** Handlers fail-closed on `main` (`list-sites.handler.ts:34-69`) but the live #658 binary runs them raw. Per-checkout context loss → `search_path=farm` (`farm.sites=0`) or unset GUC (RLS deny) → HTTP 200 `items:[]` → "No sites found" (`SitesTab.tsx:343`). This is the **reported symptom**. Separately, `region/totalArea/siteManager` always render blank (read-model vs entity drift `site.response.ts:80,92,95`). |
| **Departments** | useDepartments | **1** | **Flickers 1↔0**, same mechanism (`list-departments.handler.ts:28`). Capacity load-bar permanently 0% (`currentLoad` has no backing column). |
| **Systems** | useSystems | **1** | **Flickers 1↔0** (`list-systems.handler.ts:28`). `staleTime` undefined on list → eager refetch re-empties. site/dept `@ResolveField` swallow `TenantContextError`→null (`system.resolver.ts:245-266`). |
| **Chemicals** | useChemicals | **1** | **Flickers 1↔0** (`list-chemicals.handler.ts:28-29`). On real error the table is hidden behind an error panel; the flicker is the silent-empty path → "No chemicals found" (`ChemicalsTab.tsx:740-748`). `chemicalTypes` dropdown stays populated via mock fallback even on read failure. |
| **Suppliers** | useSuppliers | **0** | **Permanently blank — honest emptiness.** No supplier rows exist; "No suppliers found" is correct, not roulette. Would flicker once rows exist on the pre-#696 binary. |
| **Equipment** | useEquipment | **0** | **Permanently blank — honest emptiness.** `equipment=0`. (Note: this handler is raw-allowlisted, so it would flicker for any tenant that *does* hold equipment/tank rows, even after #696.) |
| **Workers** | useWorkers | **0** | **Permanently blank — honest emptiness.** `farm_workers=0`. Handler is fail-closed on main; latent risk only. |
| **Feeds** | useFeeds | **0** | **Permanently blank — honest emptiness.** `feeds=0` → route the "why no feeds" question to write/seed audit. `feedTypes` dropdown shows fabricated `FALLBACK_FEED_TYPES` regardless. |
| **Consumables** | useConsumables | **0** | **Permanently blank — honest emptiness.** `consumables=0`. |
| **Species** | useSpecies | **0** | **Permanently blank — honest emptiness.** `species=0`. Batch-create species dropdown also capped at limit 20. |

**Diagnostic rule:** a tab that toggles between its real count and 0 is the **context-loss signature** (sites/departments/systems/chemicals). A tab that is *always* 0 is **genuine emptiness** (suppliers/equipment/workers/feeds/consumables/species) — a write/seed concern, not this bug. Both render identically to the deployed code, which is exactly why deploying the fail-closed boundary matters: it makes context-loss loud and leaves only the honest empties silent.

---

## 6. Root-Cause Fix Plan (architectural, tiered)

Reference: **FARM-HIGH-060** (the `runInTenantRead` boundary) and the **queued migration of the remaining raw reads** documented in `docs/reviews/farm-expert/2026-06-28-farm-data-ssot.md` (FARM-HIGH-061..087; plan Task #9-tail / Task #23).

### Step 0 — Deploy the post-#696 image (immediate; fixes the reported symptom)

The live image is commit **#658**, which predates #696. The `/sites/setup` flicker on sites/departments/systems/chemicals is **purely the deployment gap** — those handlers are already fail-closed on `main`. Build and ship a `farm-service` image from post-#696 `main`. This converts every silent-empty on the migrated handlers into a thrown `TenantContextError` (`tenant-transaction.ts:229-244`), which the SitesTab/DepartmentsTab/etc. already render as an error+Retry panel rather than a misleading empty state. **No code change required for the reported tabs — this is a release action.**

### Step 1 — Make-it-impossible: migrate the never-migrated raw reads onto the boundary

These stay fail-open even after Step 0 because they bypass the CQRS query bus and `runInTenantRead`. Move each read into an `IQueryHandler` that wraps the read in `runInTenantRead(dataSource,'farm',tenantId,…)`:

- **Task domain:** `TaskService.findAll/getStats`, `AutoRuleService.findAll`, `RecurringTaskService.findAll` (`apps/farm-service/src/task/services/*`).
- **Water-quality:** `WaterQualityService` reads + route `water-quality.resolver.ts:78-183` through the QueryBus.
- **Harvest:** `HarvestPlanService.findAll/findById/getStats/findUpcoming/findOverdue`.
- **Maintenance:** `WorkOrderService`/`MaintenanceScheduleService`/`SparePartService` reads.
- **Fish-health:** `HealthEventService` reads.
- **Feeding analytics:** `feeding-program.resolver.ts:513-529` (`dailyFeedingExecutions`), `FeedConsumptionForecastService`/`GrowthSimulatorService`, `feeding.resolver.ts:930-940` (`feedingRecord(id)`).
- **Cleaner-fish:** `cleaner-fish.resolver.ts:405-455`.
- **Batch:** `batch-feed-assignment.resolver.ts:75-77` + its dataloader.
- **Regulatory:** `regulatory-settings.service.ts:71-81`.
- **Equipment/Tanks:** retire the `list-equipment.handler.ts` allowlist entries (`farm-read-boundary-ssot.spec.ts:41,43`) by migrating the equipment + tanks reads (these flicker for *any* tenant with equipment, independent of deploy state).

### Step 2 — Make-it-detectable: extend the read-boundary invariant beyond `IQueryHandler`

`tests/invariants/farm-read-boundary-ssot.spec.ts:82` only scans `*.handler.ts` implementing `IQueryHandler`. Every defect in Step 1 is a **resolver-inline or plain-`@Injectable`-service read** that the invariant cannot see. Extend the spec to flag raw `@InjectRepository` reads in `*.resolver.ts` and `*.service.ts` within `apps/farm-service/src/**`, with an explicit, shrinking allowlist for genuine global reference data (see below). This closes the systemic hole that let the residue persist.

### Step 3 — Fix the two BROKEN contracts (deterministic, route to owners)

- **useGrowth `growthAnalysis`:** add a mapper from `GrowthAnalysisResult` (flat) to `GrowthAnalysisResponse` (nested), or reshape the handler to the ObjectType. Handoff: `data-expert` (contract) + `frontend-expert`.
- **useInventoryCounts:** either add `locationName` as a `@ResolveField`/denormalized column on `InventoryCountResponse` or drop it from `COUNT_FIELDS`. Tighten `farm-graphql-fe-be-parity.spec.ts` to validate nested selections. Handoff: `data-expert` + `frontend-expert`.

### Step 4 — Frontend cache/stale-on-error/error-surface fixes (defense-in-depth)

- **Surface errors instead of swallowing them:** TasksPage (`TasksPage.tsx:114-126`), AutoRulesTab/RecurringTab, HarvestPlansPage, FeedingPage daily-plan cards (`FeedingPage.tsx:208-212,337`), OverviewTab pending-deliveries (`OverviewTab.tsx:37`), regulatory tabs — all must read `error` and render an explicit error/Retry state so a thrown `TenantContextError` (post-Step 1) is not re-flattened into "no data".
- **Stop masking with mock/fallback:** `FeedsTab` `FALLBACK_FEED_TYPES` (`FeedsTab.tsx:233`), HistoryTab `FALLBACK_COLUMNS` (`HistoryTab.tsx:166-172`) — gate these on a real "no config" signal, never on an errored/empty read.
- **`enabled` guard drift:** add `!!tenantId` to `useWaterQuality` (`:339,399`), `useParameterConfigs` (`:244`); move the mis-placed `enabled` out of the GraphQL `variables` object in `useParamEquipmentMapping.ts:166`, `useWaterQuality.ts:427,516`.
- **useTenantUsers:** migrate to TanStack Query with `createTenantQueryKey(tenantId,'tenant-users')` so the session-epoch makes a stale cross-tenant readback impossible after impersonation; surface an error state instead of `Promise.allSettled`→`[]`.
- **Optimistic-key mismatch:** `useDailyFeedingExecution` optimistic `get/setQueryData` must use the same `createTenantQueryKey` shape as the read (`:453`), not the bare `['feeding','daily-executions',…]` key (`:518`).

### Step 5 — Document the legitimate exceptions

Global reference tables with **no `tenantId` column** (`chemical_types`, `feed_types`, `sub_equipment_types`, `supplier_types`) are read via `@SkipTenantGuard` raw repos. Cross-tenant leakage is structurally impossible (no tenant column), so these stay raw — but they must be (a) on the new invariant's explicit reference-data allowlist and (b) reviewed for the `@Entity()` schema-discipline note (they omit `schema:` while being cross-tenant reference data; confirm the intended routing with `database-reviewer`/`data-expert`).

---

## 7. Completeness Note

**Hooks with NO backend handler (resolver-inline / service-direct, CQRS bus skipped) — already enumerated above as the Step-1 residue:** useAutoRules, useTasks, useRecurringTemplates (task services); useWaterQuality (resolver→service direct); useHarvestPlans (service direct); useMaintenance (service direct); useHealthEvents (service direct); useDailyFeedingExecution, useFeeding, `feedingRecord(id)` (resolver/service direct); useCleanerFish, useBatchFeedAssignments (resolver direct); useRegulatory (service direct). None are NOT-FOUND (no missing root field); all resolve, just outside the boundary.

**Backend reads with NO active frontend consumer (dead read paths):** `useGrowth.latestGrowthMeasurement`, `useGrowth.growthMeasurement(id)`; `useFeeding.ActiveTanks`, `useFeeding.ProjectHarvestDate`, `useFeeding.EstimateSGR`; `useFeedingRecords.useFeedingRecord(id)` (defined, `FEEDING_RECORD_QUERY` only referenced by the unused hook); `useConsumables.useConsumable`; `useParameterConfigs.parameterConfig`/`parameterConfigByCode`/`useReorderParameterConfigs`; `useParamEquipmentMapping.equipmentParameters`; `useWaterQuality.waterQuality`/`latestWaterQuality`. These carry the same fail-open class but no live blast radius.

**Mock-data / fabricated fallbacks (mask read failure or have no read-back path):**
- `FeedsTab` → `FALLBACK_FEED_TYPES` (`FeedsTab.tsx:233`).
- `ChemicalsTab` → `FALLBACK_CHEMICAL_CATEGORIES` (`ChemicalsTab.tsx:417`).
- `HistoryTab` → `FALLBACK_COLUMNS` (`HistoryTab.tsx:62-68,166-172`).
- `useRegulatory` report-history lists → `mockSeaLiceReports`/`mockCleanerFishReports`/`mockSmoltReports`/`mockSlaughterReports`/`mockBiomassReports` (submitted reports have **no read-back path at all**).
- Pure-compute resolvers (no DB, never silent-empty): `projectHarvestDate`, `estimateSGR`, `parameterTemplates` (`list-parameter-templates.handler.ts:33-44`), `maskinportenStatus` (`maskinporten.service.ts:488-502`, always `configured:false`).

**External-API hooks NOT covered by this DB-read trace** (Sentinel Hub OAuth/geospatial proxy, weather, marine, AOI, map-point, realtime stream, REST file-upload). These do not read tenant Postgres tables and so are outside the silent-empty/RLS mechanism, but several touch tenant-scoped credentials/quota and warrant a separate pass:
- `useFarmRealtimeStream.ts` (SSE/WS stream; consumes `useTanks` data).
- File-upload REST paths inside `useChemicals.ts:572-579,729-737` (`POST /api/upload/chemical-document`, `/api/upload/presigned-url`, carry `x-tenant-id`).
- Sentinel Hub proxy / weather / marine / AOI / map-point hooks (not in the supplied `setupTabHooks`/hook list). Per the farm-domain invariants these require: server-only OAuth (`@HideField()` on token fields), `SentinelHubProxyController`-only egress, AES-256-GCM secret-at-rest, **tenant-scoped token cache**, concurrent-refresh dedupe, per-tenant rate limiting, and a strict URL allowlist. Handoff: `auth-security-expert` (gateway credential routing) + `multi-tenant-saas-expert` (per-tenant quota/cache isolation); contract changes on `libs/event-contracts/src/farm-events.ts` → `data-expert`.

---

# Appendix A — Tenant-Context + Data-Read Architecture Map (full)

I have traced the full path. Here is the precise technical map.

---

# Farm-service Tenant-Context + Data-Read Architecture Map

Anchored to the live runtime evidence: data physically lives in `tenant_7f6b08ab90e246d3` (`tenant.sites=1`, `tenant.departments=1`, `tenant.systems=1`, `tenant.chemicals=1`, `tenant.automation_programs=2`); the source `farm` schema is empty (`farm.sites=0`); 314 tenant tables have RLS enabled with 156 policies keyed on `app.current_tenant`; and the deployed binary (`farm-service:2de19d36` = #658) predates the #696 fail-closed boundary.

---

## 1. How a farm-service DB connection gets tenant routing for a READ

A read is routed by **four independent mechanisms stacked on one pooled `pg` connection**. Two are pool-checkout patches (always on the deployed image), two are the transaction-local boundary (added in #696, NOT on the deployed image).

### Request-context establishment (the ALS frame everything reads from)

Middleware chain, `apps/farm-service/src/app.module.ts:541-551` (executes in array order):
`StripInternalHeadersMiddleware → VerifiedUserAssertionMiddleware → CorrelationIdMiddleware → RequestContextMiddleware → UserContextMiddleware → TenantContextMiddleware → TenantSchemaMiddleware`.

- `VerifiedUserAssertionMiddleware` (`libs/backend-common/src/middleware/verified-user-assertion.middleware.ts:58-59`) is the trust anchor on the production gateway path: it sets `req.tenantId = assertion.effectiveTenantId ?? assertion.tenantId` from the HMAC-verified assertion, after asserting `assertion.effectiveTenantId === req.verifiedIdentity.tenantId` (line 51-56).
- `RequestContextMiddleware` (`libs/backend-common/src/logging/request-context.middleware.ts:62-88`) opens the AsyncLocalStorage frame via `requestContextStorage.run(requestContext, …)`. It reads the verified tenant FIRST (`verifiedTenantId = req.tenantId`, line 62), then `x-tenant-id`, then the user payload — putting `tenantId` into the ALS `RequestContext`.
- `TenantSchemaMiddleware` (`libs/backend-common/src/middleware/tenant-schema.middleware.ts:52-92`) derives `tenant_<uuid>` via `getTenantSchemaName`, verifies the schema physically exists (`checkSchemaExists`, LRU-cached, lines 96-104), throws `UnauthorizedException('Tenant not provisioned')` if missing (line 66), and **re-runs the rest of the request inside a fresh ALS store carrying `schemaName`** (`requestContextStorage.run(newStore, () => next())`, line 92) — this re-`run()` is the fix for async-hop context loss (docblock lines 72-84).

The ALS `RequestContext` shape (`libs/backend-common/src/logging/request-context.ts:8-43`) carries `tenantId`, `schemaName`, and `bypassRls`. `getRequestContext()` returns `{}` when no frame is active (line 57-59) — the root of every silent-empty failure.

### (a) Connection-pool checkout routing — search_path (ALWAYS ON, deployed)

`createTenantConnectionBootstrap('farm')` (`apps/farm-service/src/app.module.ts:59`, registered as a provider at line 525) monkey-patches `pool.connect` (`libs/backend-common/src/database/tenant-connection-bootstrap.service.ts:85-198`):
- On every checkout it reads `getRequestContext()` (line 118) and resolves a schema via `resolveTenantSchemaName(ctx.schemaName, ctx.tenantId)` (line 119, 204-217) — falling back from `schemaName` to deriving from `tenantId`.
- If the schema matches `TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/` (line 12, 124): `SET search_path TO "tenant_<uuid>", "farm", public` (line 127-128).
- Otherwise (no request context — bootstrap/migration/cron/lost-context): `SET search_path TO "farm", public` (line 99, 145). The docblock (lines 38-67) documents the 2026-04-07 split-brain incident that forced re-asserting search_path on **every** checkout.

### (b) Connection-pool checkout routing — RLS GUC (ALWAYS ON, deployed)

`RlsModule.forPoolService({ serviceName: 'farm', … })` (`apps/farm-service/src/app.module.ts:462-470`) registers `RlsConnectionBootstrap` which also patches `pool.connect` (`libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts:132-214`). On every checkout it runs `SELECT set_config('app.current_tenant', $1, false), set_config('app.bypass_rls', $2, false)` (line 94-97, 163) with values from `readRlsContext()` (line 240-258): `tenantId` from `getRequestContext().tenantId` **only if it passes `UUID_REGEX`** (line 246), else empty string; `bypass='on'` only if `ctx.bypassRls===true`. Session scope (`is_local=false`) because a pooled connection spans many autocommit queries (docblock 39-50); re-asserted every checkout so there is "no leakage window" (lines 48-49). The two pool patches chain cleanly (docblock 30-37).

### (c) Per-transaction assert — the #696 fail-closed boundary (NOT on the deployed image)

`runInTenantRead` / `runInTenantTransaction` (`libs/backend-common/src/database/tenant-transaction.ts:251-344`):
1. `withTenantContext(tenantId, …)` (line 257/308) establishes/overwrites the ALS frame with `tenantId` + derived `schemaName` (`libs/backend-common/src/context/with-tenant-context.ts:43-69`) — so even a NATS/cron path gets routing.
2. `pinTenantTransactionSearchPath` (line 264/316, impl 118-154) runs `SELECT pg_catalog.set_config('search_path', '"tenant_<uuid>", "farm", public', true)` — **transaction-local** (`is_local=true`).
3. `assertTenantTransactionContext` (line 265/317, impl 183-245) is the load-bearing assertion: it OWNS the GUC transaction-locally (`set_config('app.current_tenant', tenantId, true)`, line 203-206), then reads back `SELECT current_schema(), current_setting('app.current_tenant', true)` (line 209-212) and throws `TenantContextError{SCHEMA_MISMATCH}` if `current_schema() !== tenant_<uuid>` (line 229-236) or `{RLS_MISMATCH}` if the GUC doesn't echo the tenant (line 237-244). `current_schema()` returns the first **existing** schema in search_path, so a missing/un-provisioned tenant schema (which falls through to `farm`) is caught (docblock 170-172).
4. `runInTenantRead` additionally opens `READ COMMITTED` + `SET TRANSACTION READ ONLY` (line 312, 315) so accidental writes structurally fail.

`runInSourceRead` (line 399-446) is the sanctioned cross-tenant counterpart: pins `search_path` to `"farm", public`, sets `app.bypass_rls='on'` transaction-locally (line 421), and asserts `current_schema()===farm` (line 422) — used by reference-data reads and federation `__resolveReference`.

### (d) RLS row filter — `app.current_tenant` GUC (ALWAYS ON at the DB, deployed)

The policy is generated by `buildTenantPolicyUsingClause` (`libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts:271-280`):
```
current_setting('app.bypass_rls', true) = 'on'
OR "<tenant_col>" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
```
applied `FOR ALL … USING … WITH CHECK` with `ENABLE` + `FORCE ROW LEVEL SECURITY` (lines 527-553). The `NULLIF(...)::uuid` is the deliberate fail-closed form: an unset GUC → empty string → `NULL` → predicate UNKNOWN → **zero rows, no error** (behaviour matrix, docblock 52-60). `users`/`tenants` identity tables are auto-skipped (`DEFAULT_IDENTITY_TABLES`, line 145, 353-362). Runtime per-tenant sweep is done by `TenantRlsSyncService` (`syncTenantSchemas`, app.module.ts:455-460/468) because `CREATE TABLE LIKE INCLUDING ALL` does not copy policies.

---

## 2. Exact failure modes: EMPTY-but-no-error vs ERROR vs WRONG-TENANT

Tie-in: data is in `tenant_7f6b08ab90e246d3`, `farm.sites=0`, RLS active, deployed image = pre-#696 (mechanisms (a),(b),(d) live; (c) absent).

### EMPTY-but-no-error (the "data disappears" class — the dominant production failure)

Occurs whenever the read executes without #696's assertion AND tenant context is missing/wrong at checkout. Two sub-modes, each independently sufficient:

- **Search_path fallback to `farm`:** `getRequestContext()` returns `{}` at pool checkout (lost ALS frame across an async hop, a NATS/cron path without `withTenantContext`, or a SUPER_ADMIN whose `effectiveTenantId` was never resolved). `tenant-connection-bootstrap.service.ts:139-145` then sets `search_path = farm, public`. The query resolves against `farm.sites` (physically 0 rows) → **empty list, HTTP 200, no error.**
- **RLS GUC unset → deny-all:** even if search_path correctly points at `tenant_<uuid>`, if `readRlsContext()` found no UUID tenant (`rls-connection-bootstrap.service.ts:246` fails), the GUC is `''` → `NULLIF('','')::uuid = NULL` → every one of the 314 RLS tables returns **0 rows, no error.**

These are indistinguishable from a legitimately-empty table — which is exactly why the runtime split matters: `tenant.suppliers/equipment/workers/feeds/consumables/species = 0` are **honestly empty** and will always render blank regardless of context; only `sites/departments/systems/chemicals/automation_programs` (which hold rows) can "appear then disappear." A tab that toggles between 1 row and 0 rows is the context-loss signature; a tab that is always 0 is genuine emptiness. Both look identical to the deployed code.

### ERROR (only with #696, NOT deployed)

`runInTenantRead`/`runInTenantTransaction` convert both silent-empty modes into a thrown `TenantContextError` (`tenant-transaction.ts:229-244`, `tenant-context-error.ts:39-61`): `SCHEMA_MISMATCH` when `current_schema()` resolved to `farm` instead of `tenant_<uuid>`, `RLS_MISMATCH` when the GUC didn't echo the tenant. On the deployed #658 binary this path does not run, so production cannot currently surface these as errors — it silently empties.

### WRONG-TENANT (cross-tenant leak)

Requires a pooled connection to retain a prior request's tenant state while a new request fails to overwrite it. Both pool patches re-assert on **every** checkout, so the only windows are: (i) one patch fails its `SET`/`set_config` (the code releases the connection with the error flag — `tenant-connection-bootstrap.service.ts:175`, `rls-connection-bootstrap.service.ts:202` — so this fails rather than leaks); (ii) a read that bypasses the pool patches entirely (raw `dataSource.query` on a checked-out connection whose session GUC still holds tenant A). Because the RLS deny-default dominates (unset → empty, not wrong), the realistic production symptom is **empty, not cross-tenant** — the architecture biases toward silent-empty over leak. The `intermittent show/hide` reported on `/sites/setup/sites` is the non-deterministic interleaving of correct-context checkouts (rows appear) and lost-context checkouts (RLS/search_path deny → rows vanish), precisely the SUPER_ADMIN act-as scenario the gateway middleware docblock calls "data sometimes loads, sometimes not" (`apps/gateway-api/src/middleware/effective-tenant.middleware.ts:11-13`).

---

## 3. Fail-closed boundary vs raw `@InjectRepository` — and the count split

- **Boundary read** (`runInTenantRead`): runs inside `withTenantContext` + transaction-local pin + read-back assertion; a lost/wrong context throws. Example: `apps/farm-service/src/site/handlers/get-site.handler.ts:26-31` (injects only `DataSource`, reads via `queryRunner.manager.findOne`) and `list-sites.handler.ts:34-69` (`queryRunner.manager.createQueryBuilder`).
- **Raw `@InjectRepository` read**: relies solely on pool-checkout (a)+(b)+(d); on context loss it silently empties (FARM-HIGH-061/062 documented the masking `null`/"connection pool race conditions" comment that was removed).

**Count reconciliation (current main, NOT the deployed binary):**
- `runInTenant*`/`runInSourceRead` appears across 138 files (`grep`), of which ~116 are handlers — matching the runtime `handlersUsingBoundary:116`.
- `@InjectRepository` appears in **72** `*.handler.ts` files (158 occurrences) — matching `handlersRawInjectRepository:72`. **But this 72 is not 72 raw reads.** It is dominated by **command handlers** that were migrated to `runInTenantTransaction` in FARM-HIGH-078 yet kept a now-legacy `@InjectRepository` in their constructor (constructors deliberately unchanged) — e.g. `apps/farm-service/src/batch/handlers/record-mortality.handler.ts` is an `ICommandHandler` that uses `runInTenantTransaction` (line 20) **and** still declares `@InjectRepository(Batch)` (line 60). These appear in BOTH greps.
- The genuine raw-read residue is enforced down to exactly **6 allowlisted query handlers** by the build-time invariant `tests/invariants/farm-read-boundary-ssot.spec.ts:34-48` (it fails the build if any new `IQueryHandler` reintroduces `@InjectRepository`): `batch/get-batch-performance`, `equipment/{get-equipment-types,get-sub-equipment-types,list-equipment}`, `storage/list-storage-inventory-by-cursor`. All five remaining are reference-data/federation/cursor-primitive reads tracked under plan Task #23 / #9-tail. `get-farm` already went hybrid (`runInTenantRead` + `runInSourceRead`).

**Deployment caveat (critical):** the deployed image `farm-service:2de19d36` = #658 predates FARM-HIGH-061..086 and #696. So in the **live runtime**, the boundary migration has effectively not happened — reads are genuinely raw, relying only on pool-checkout search_path + RLS GUC, with no read-back assertion. The 116/6 split describes post-#696 `main`, not the running binary. This is why the SSoT note reads "live runtime is pre-#696 fail-open code."

---

## 4. How gateway-api routes a farm GraphQL operation and carries tenant id

Apollo Federation. A farm operation hits `/graphql` on the gateway, the query planner dispatches sub-requests to the farm subgraph via `AuthenticatedDataSource` (`apps/gateway-api/src/federation/authenticated-data-source.ts`).

**Tenant resolution authority is the gateway, not the subgraph header:**
- `EffectiveTenantMiddleware` (`apps/gateway-api/src/middleware/effective-tenant.middleware.ts:130-202`) is the single tenant-resolution authority. Regular user → `effectiveTenantId = JWT tenantId`; a divergent act-as → 403 (line 145-150). SUPER_ADMIN → the act-as target only after UUID + tenant-ACTIVE (`isLoginAllowed`, fail-closed in prod, line 170-179) + MFA step-up (line 184-190) checks. It also writes the effective tenant into the ALS logging frame (`getRequestContext().tenantId = tenantId`, line 126). The browser's `x-act-as-tenant`/`x-tenant-id` are captured pre-strip as untrusted intent (`CaptureRequestedTenantMiddleware`, line 75-87) then stripped.

**Tenant id is carried into the subgraph two ways, the HMAC being authoritative:**
- `willSendRequest` (`authenticated-data-source.ts:175-258`) sets the `x-tenant-id` header to `req.effectiveTenantId ?? req.user.tenantId` (line 203-205) **and** mints `x-verified-user-assertion` via `buildGatewayVerifiedUserAssertion`, signing `effectiveTenantId` (line 244) plus `roles`, `assignedSiteIds`, `mobileFeatures`, `planLevel`.
- The fetch-boundary wrapper `withServiceIdentitySigning` (line 136-173) HMAC-signs the exact wire bytes including `tenantId` (line 148-166) using `buildSignedInternalHeaders` (`libs/backend-common/src/utils/service-identity.util.ts`) — so a compromised intermediary cannot swap tenant in flight.

**Subgraph side:** `ServiceIdentityGuard` verifies the HMAC; `VerifiedUserAssertionMiddleware` (`verified-user-assertion.middleware.ts:51-59`) rejects unless `assertion.effectiveTenantId === req.verifiedIdentity.tenantId`, then sets `req.tenantId = assertion.effectiveTenantId` and strips the legacy raw identity headers (line 93-97). `RequestContextMiddleware` reads that verified `req.tenantId` first (line 62) — so **the JWT claim (signed into `effectiveTenantId`), not the raw `x-tenant-id` header, drives both the search_path patch and the RLS GUC.** The header `x-tenant-id` is a pre-assertion fallback that must never outrank the signed value (docblock 54-61). This is the layer the deployed #658 image's tenant correctness hinges on; if `effectiveTenantId` resolves null (SUPER_ADMIN, no act-as), the subgraph gets no tenant → search_path falls to `farm` + GUC unset → silent empty.

---

## 5. The web graphqlClient + react-query tenant keys / invalidation

**Transport:** farm-module hooks import the singleton `graphqlClient` from `@aquaculture/shared-ui` (`web/modules/farm-module/src/hooks/useSites.ts:6`), defined at `web/shared-ui/src/utils/api-client.ts:953` (`class GraphQLClient`, line 517). `request()` (line 527-595) POSTs to `config.graphqlUrl`, and on every call attaches `Authorization: Bearer <token>` (line 562-564) and `X-Tenant-Id: <getTenantId()>` (line 567-570). So the browser **does** send tenant id — but per Section 4 it is informational only; the gateway re-derives `effectiveTenantId` from the JWT and HMAC-signs it, ignoring the raw header for trust. `getTenantId()` (line 484-496) reads in-memory state, then `sharedState`, then localStorage `tenant_id` — and is updated on token refresh (line 317-318) and tenant switch (`setTenantId`, line 444-448).

**Tenant query keys** (`web/shared-ui/src/utils/tenant-query-keys.ts`):
- `createTenantQueryKey(tenantId, ...segments)` (line 40-57) returns `['tenant', tenantId, ...segments, sessionEpochSegment()]` — tenant-prefixed (cache isolation per FE-CRITICAL-014/015/016) with the **session epoch appended LAST**. Used for `useQuery` keys, e.g. `useSites.ts:237` (`createTenantQueryKey(tenantId, 'sites', 'list', tenantId, filter)`).
- `createTenantInvalidationKey(tenantId, ...segments)` (line 82-87) returns `['tenant', tenantId, ...segments]` with **NO epoch** — used for `invalidateQueries`/`removeQueries`, e.g. `useSites.ts:292, 319-320, 382-385, 527-532`.

**Why two builders (the FARM-HIGH-065/066/082 bug):** TanStack invalidation does a left-prefix match. Because `createTenantQueryKey` appends `{epoch}` last, a stored key `['tenant', t, 'systems', 'list', filter, {epoch}]` is NOT matched by an invalidation filter `['tenant', t, 'systems', 'list', {epoch}]` — index 4 is `{epoch}` in the filter but `filter` in the stored key, so the invalidation silently misses and the list shows stale data until `staleTime` (the "data doesn't refresh after a mutation" symptom). `createTenantInvalidationKey` (epoch-less prefix) left-prefix-matches every args-bearing stored key under the domain segments across epoch generations. FARM-HIGH-082 swept all ~40 farm-module hooks so invalidate/remove filters use the epoch-less builder while `useQuery` keys keep the epoch'd builder.

**Tenant-switch interaction / stale cross-tenant cache:** on switch, `setTenantId` (api-client.ts:444-448) updates the tenant id and the session epoch advances (`sessionEpochSegment`), so the next `useQuery` materializes under a fresh `['tenant', newId, …, {newEpoch}]` key — a SUPER_ADMIN A→B→A round-trip gets a fresh generation rather than the pre-switch (possibly stale) cache (docblock 51-56). Stale prior-tenant entries are orphaned and GC'd; a bulk `removeQueries({ queryKey: ['tenant', oldTenantId] })` evicts them in one call. The `enabled: !!token && !!tenantId` guard on every hook (e.g. `useSites.ts:246, 266, 355, 495`) prevents a request firing under `['tenant', null, …]` before auth resolves.

**Net for the reported symptom:** the front end is largely correct post-FARM-HIGH-082 (epoch'd reads, epoch-less invalidation, tenant-prefixed keys, refetch-error stale-render guards from FARM-HIGH-064/087). The intermittent appear/disappear on `/sites/setup/sites` is therefore not primarily a key/cache problem — it is the **backend** lost-tenant-context silent-empty (Section 2) on the deployed pre-#696 binary: each of the 10 setup-tab hooks (`useSites`, `useDepartments`, `useSystems`, `useChemicals`, etc.) is a separate GraphQL op → separate gateway→subgraph hop → separate pool checkout, so per-request context variance makes data-bearing tabs (sites/departments/systems/chemicals) flicker between 1 row and 0 rows while genuinely-empty tabs (suppliers/equipment/workers/feeds/consumables/species, all 0 in `tenant_7f6b08ab90e246d3`) stay blank for an entirely different and legitimate reason.

---

## Key files (all absolute)

- `/var/aqua-saas/libs/backend-common/src/database/tenant-transaction.ts` — #696 fail-closed boundary (runInTenantRead/Transaction/SourceRead, assertTenantTransactionContext)
- `/var/aqua-saas/libs/backend-common/src/database/tenant-connection-bootstrap.service.ts` — search_path pool patch (a)
- `/var/aqua-saas/libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts` — `app.current_tenant`/`app.bypass_rls` pool patch (b)
- `/var/aqua-saas/libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts` — RLS predicate generator (NULLIF fail-closed) (d)
- `/var/aqua-saas/libs/backend-common/src/database/tenant-context-error.ts` — typed SCHEMA_MISMATCH/RLS_MISMATCH error
- `/var/aqua-saas/libs/backend-common/src/context/with-tenant-context.ts`, `/var/aqua-saas/libs/backend-common/src/logging/request-context.ts`, `/var/aqua-saas/libs/backend-common/src/logging/request-context.middleware.ts` — ALS frame
- `/var/aqua-saas/libs/backend-common/src/middleware/tenant-schema.middleware.ts`, `/var/aqua-saas/libs/backend-common/src/middleware/tenant-context.middleware.ts`, `/var/aqua-saas/libs/backend-common/src/middleware/verified-user-assertion.middleware.ts`
- `/var/aqua-saas/apps/farm-service/src/app.module.ts:441-552` — bootstrap + middleware wiring
- `/var/aqua-saas/apps/farm-service/src/site/handlers/get-site.handler.ts`, `list-sites.handler.ts` — boundary read examples; `/var/aqua-saas/apps/farm-service/src/batch/handlers/record-mortality.handler.ts` — command handler with runInTenantTransaction + legacy @InjectRepository
- `/var/aqua-saas/tests/invariants/farm-read-boundary-ssot.spec.ts` — 6-entry raw-read allowlist (the genuine residue)
- `/var/aqua-saas/apps/gateway-api/src/federation/authenticated-data-source.ts`, `/var/aqua-saas/apps/gateway-api/src/middleware/effective-tenant.middleware.ts`, `/var/aqua-saas/libs/backend-common/src/utils/service-identity.util.ts` — gateway tenant resolution + HMAC binding
- `/var/aqua-saas/web/shared-ui/src/utils/api-client.ts:517-595,953` — graphqlClient; `/var/aqua-saas/web/shared-ui/src/utils/tenant-query-keys.ts` — key builders; `/var/aqua-saas/web/modules/farm-module/src/hooks/useSites.ts` — representative hook
- `/var/aqua-saas/docs/reviews/farm-expert/2026-06-28-farm-data-ssot.md` — FARM-HIGH-060..087 boundary remediation record

---

## FARM-HIGH-088 — task-domain reads bypass the CQRS bus + fail-closed boundary

The task module's GraphQL reads — `tasks`, `taskStats`, `myTasks`, `todaysTasks`
(`TaskResolver` → `TaskService`), `autoRules`/`autoRule` (`AutoRuleResolver` →
`AutoRuleService`), and `recurringTemplates`/`recurringTemplate`
(`RecurringTemplateResolver` → `RecurringTaskService`) — skip the CQRS query bus
and read via raw `@InjectRepository` query builders / `repo.find` with **no**
`runInTenantRead` boundary. On a pooled connection that lost the tenant
AsyncLocalStorage frame, these reads silently return empty (RLS deny / `farm`
schema fallback) — the "data appears then disappears" class (FARM-HIGH-060).
These service-layer reads were invisible to the #696 audit (which scanned only
`IQueryHandler`s), so they were not captured by FARM-HIGH-061..076.

**Remediation (this finding):** migrate every task-domain GraphQL read onto a
dedicated `IQueryHandler` wrapped in `runInTenantRead`; resolvers dispatch via
`queryBus`; delete the now-dead resolver-only service read methods. The
write-path `findById` helper stays raw until the task **write** path migrates to
command handlers (tracked separately).
