# Storage Data Entry — Implementation Plan

**Goal:** Enable full data entry across all 9 storage tabs — stock movements, transfers, inventory CRUD, and inventory counts.

**Architecture:** Backend is 100% complete (6 tables, 8 CQRS commands, 9 GraphQL mutations). Frontend hooks exist but are disconnected from UI. This plan wires existing hooks to new forms and builds the missing inventory count backend.

**Tech Stack:** React + TypeScript, GraphQL mutations via useStorageInventory/usePurchaseOrders hooks, NestJS CQRS backend, TypeORM entities, PostgreSQL

---

## Security & Performance Requirements (Non-Negotiable)

### Tenant Data Isolation
- Every storage table uses schema-per-tenant pattern (tenant_xxx schema)
- Every GraphQL query/mutation MUST use @CurrentTenant() decorator
- Every TypeORM query MUST include WHERE tenant_id = :tenantId
- Cross-tenant data access is physically impossible (separate PostgreSQL schemas)
- Mobile app sends X-Tenant-Id header on every request, validated by TenantSchemaMiddleware

### Security Best Practices
- All mutations require @Roles() decorator (TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)
- Input validation via class-validator on every DTO (no raw user input to DB)
- Stock movement records are immutable (no UPDATE/DELETE — append-only audit trail)
- Supplier contact data sanitized against XSS
- GraphQL depth limiting to prevent DoS via nested queries
- Rate limiting on mutation endpoints (ThrottlerModule)

### Performance Best Practices
- Pagination on all list queries (max 100 items per page)
- Database indexes on tenant_id, storage_location_id, item_type, performed_at
- React Query caching with staleTime for read-heavy tabs (30s inventory, 60s locations)
- Optimistic UI updates on mutations for perceived speed
- Lazy loading of tab content (only fetch when tab is active)
- Mobile: offline-first with IndexedDB queue for stock movements

---

## Current State

| Area | Backend | Frontend | Status |
|------|---------|----------|--------|
| Storage Locations CRUD | COMPLETE | COMPLETE | WORKING |
| Storage Overview | COMPLETE | COMPLETE | WORKING |
| Purchase Orders | COMPLETE | COMPLETE | WORKING |
| Record Stock Movement | COMPLETE (mutation + handler) | Hook exists, NO form | BACKEND ONLY |
| Transfer Stock | COMPLETE (mutation + handler) | Hook exists, NO form | BACKEND ONLY |
| Stock Tabs (Feed/Chemical/Consumable/Healthcare) | COMPLETE (read) | Read-only tables, no Add/Edit | READ ONLY |
| Inventory Count | NOT IMPLEMENTED | MOCK DATA | NOT IMPLEMENTED |

## Phase 1: Stock Movement Entry (Critical)

**Priority: CRITICAL — enables manual stock recording**

### Task 1.1: RecordStockMovementModal

**Files:**
- Create: `web/modules/farm-module/src/pages/storage/components/RecordStockMovementModal.tsx`
- Modify: `web/modules/farm-module/src/pages/storage/components/StockMovementsTab.tsx`

**Form fields:**
- Movement Type: IN | OUT | WASTE | ADJUSTMENT | RETURN (select)
- Item Type: FEED | CHEMICAL | CONSUMABLE | HEALTHCARE (select)
- Item: dynamic dropdown based on item type (useFeedList / useChemicalList / useConsumableList)
- Quantity + Unit
- Location (from/to depending on movement type)
- Reason (text)
- Reference (optional text)

**Hook:** `useRecordStockMovement()` from `useStorageInventory.ts` — already exists

- [ ] Create RecordStockMovementModal component with form validation
- [ ] Add "Record Movement" button to StockMovementsTab header
- [ ] Wire modal open/close state
- [ ] Connect form submit to useRecordStockMovement mutation
- [ ] Invalidate stockMovements + storageInventory queries on success
- [ ] Test: verify movement appears in table after creation

### Task 1.2: TransferStockModal

**Files:**
- Create: `web/modules/farm-module/src/pages/storage/components/TransferStockModal.tsx`
- Modify: `web/modules/farm-module/src/pages/storage/components/StockMovementsTab.tsx`

**Form fields:**
- Item Type + Item (same as above)
- Quantity + Unit
- From Location (dropdown from useStorageLocations)
- To Location (dropdown, exclude From Location)
- Reason (optional)

**Hook:** `useTransferStock()` from `useStorageInventory.ts` — already exists

- [ ] Create TransferStockModal component
- [ ] Add "Transfer Stock" button next to "Record Movement"
- [ ] Wire to useTransferStock mutation
- [ ] Invalidate queries on success

## Phase 2: Stock Tab Data Entry (High)

**Priority: HIGH — enables direct inventory management**

### Task 2.1: Add "Record Stock In" to each stock tab

The 4 stock tabs (Feed, Chemical, Consumable, Healthcare) are read-only. Add a quick-entry button that opens RecordStockMovementModal pre-filled with the tab's item type and movement type = IN.

**Files:**
- Modify: `web/modules/farm-module/src/pages/storage/components/FeedStockTab.tsx`
- Modify: `web/modules/farm-module/src/pages/storage/components/ChemicalsStockTab.tsx`
- Modify: `web/modules/farm-module/src/pages/storage/components/ConsumablesStockTab.tsx`
- Modify: `web/modules/farm-module/src/pages/storage/components/HealthcareStockTab.tsx`

- [ ] Add "Add Stock" button to each tab header
- [ ] Open RecordStockMovementModal with pre-filled itemType and movementType=IN
- [ ] Add "Adjust" action per row (opens modal with movementType=ADJUSTMENT, pre-filled item)
- [ ] Add "Write Off" action per row (opens modal with movementType=WASTE, pre-filled item)

### Task 2.2: Fix Healthcare PO item source

**File:** `web/modules/farm-module/src/pages/storage/components/CreatePurchaseOrderModal.tsx`

- [ ] When category=HEALTHCARE, use a dedicated healthcare/consumable list instead of reusing chemicalsData

## Phase 3: Inventory Count (Major — Backend + Frontend)

**Priority: MEDIUM — new feature, requires backend entity + CQRS**

### Task 3.1: Backend — Entity + Migration

**Files:**
- Create: `apps/farm-service/src/storage/entities/inventory-count.entity.ts`
- Create: `apps/farm-service/src/storage/entities/inventory-count-item.entity.ts`
- Create: `apps/farm-service/src/database/migrations/1773000000000-AddInventoryCounts.ts`

**Entity design:**
```
inventory_counts: id, tenant_id, count_number, storage_location_id, status (DRAFT|IN_PROGRESS|COMPLETED|APPROVED), started_at, completed_at, performed_by, approved_by, notes, version
inventory_count_items: id, tenant_id, inventory_count_id (FK), item_type, item_id, item_name, expected_quantity, actual_quantity, variance, unit, notes
```

- [ ] Create InventoryCount entity with TypeORM decorators
- [ ] Create InventoryCountItem entity
- [ ] Create migration file
- [ ] Add to MODULE_SCHEMAS in schema-manager.service.ts
- [ ] Register entities in storage.module.ts TypeOrmModule.forFeature

### Task 3.2: Backend — CQRS Commands + Queries

**Files (create all):**
- `apps/farm-service/src/storage/commands/create-inventory-count.command.ts`
- `apps/farm-service/src/storage/commands/submit-inventory-count.command.ts`
- `apps/farm-service/src/storage/commands/approve-inventory-count.command.ts`
- `apps/farm-service/src/storage/handlers/create-inventory-count.handler.ts`
- `apps/farm-service/src/storage/handlers/submit-inventory-count.handler.ts`
- `apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts`
- `apps/farm-service/src/storage/queries/list-inventory-counts.query.ts`
- `apps/farm-service/src/storage/handlers/list-inventory-counts.handler.ts`

- [ ] Implement CreateInventoryCount: creates count with all items from storage_inventory for that location
- [ ] Implement SubmitInventoryCount: calculates variance, sets status=COMPLETED
- [ ] Implement ApproveInventoryCount: updates storage_inventory with actual quantities, creates ADJUSTMENT movements
- [ ] Implement ListInventoryCounts query
- [ ] Add GraphQL mutations/queries to storage.resolver.ts
- [ ] Register handlers in storage.module.ts

### Task 3.3: Frontend — Replace Mock with Real

**Files:**
- Create: `web/modules/farm-module/src/hooks/useInventoryCounts.ts`
- Rewrite: `web/modules/farm-module/src/pages/storage/components/InventoryCountTab.tsx`
- Create: `web/modules/farm-module/src/pages/storage/components/StartInventoryCountModal.tsx`
- Create: `web/modules/farm-module/src/pages/storage/components/InventoryCountDetailModal.tsx`

- [ ] Create useInventoryCounts hook (list, create, submit, approve)
- [ ] Replace mock import with real GraphQL queries
- [ ] Create StartInventoryCountModal (select location, auto-populate items)
- [ ] Create InventoryCountDetailModal (enter actual quantities, see variance)
- [ ] Add "Start Count" button to tab header
- [ ] Add "Submit" and "Approve" actions per count row

## Phase 4: PO Enhancement (Low)

- [ ] Add UpdatePurchaseOrderCommand (edit items, supplier, dates)
- [ ] Add edit button to PurchaseOrdersTab

---

## Phase 5: Mobile Storage (AquaMobil)

**Priority: HIGH — warehouse workers operate on mobile devices in the field**

### Task 5.1: Mobile Storage Hub Page

**Files:**
- Create: `web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx`
- Modify: `web/apps/aquamobil/src/App.tsx` (add route)
- Modify: `web/apps/aquamobil/src/pages/record/RecordHubPage.tsx` (add storage entry)
- Modify: `web/apps/aquamobil/src/pages/HomePage.tsx` (add quick action)
- Modify: `web/apps/aquamobil/src/hooks/useMobilePermissions.ts` (add 'storage' feature)

**Mobile-optimized actions (big touch targets, offline-capable):**
- Record Stock In (receive delivery at dock)
- Record Stock Out (dispense feed/chemical)
- Transfer Between Locations
- Quick Waste Write-Off
- View Current Stock (by location)

- [ ] Add 'storage' to MobileFeature type + FALLBACK_SETTINGS
- [ ] Create StorageHubPage with action cards (same pattern as RecordHubPage)
- [ ] Add route `/storage/*` to App.tsx with FeatureRoute guard
- [ ] Add "Storage" quick action to HomePage + RecordHubPage
- [ ] Add 'storage' to MobileLayout Record tab features

### Task 5.2: Mobile Stock Movement Form

**Files:**
- Create: `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx`

**Mobile-first design:**
- Step 1: Select movement type (large icon buttons: IN / OUT / WASTE)
- Step 2: Select item type + item (searchable dropdown)
- Step 3: Enter quantity + select location
- Step 4: Optional notes/reason
- Step 5: Confirm and submit

**Offline support:** Queue via existing offline-queue.ts with new OperationType 'recordStockMovement'

- [ ] Create StockMovementPage with step-by-step wizard
- [ ] Add 'recordStockMovement' to OperationType union in types.ts
- [ ] Add mutation string to useOfflineQueue MUTATIONS record
- [ ] Wire GraphQL mutation (same as web: recordStockMovement)
- [ ] Add success/error feedback with haptic

### Task 5.3: Mobile Stock Transfer Form

**Files:**
- Create: `web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx`

- [ ] Create StockTransferPage (from location → to location → item → quantity)
- [ ] Add 'transferStock' to OperationType for offline support
- [ ] Wire to transferStock mutation

### Task 5.4: Mobile Stock View (Read-Only)

**Files:**
- Create: `web/apps/aquamobil/src/pages/storage/StockViewPage.tsx`

- [ ] Location selector → show items in that location
- [ ] Swipe-to-action: quick OUT or WASTE from item row
- [ ] Pull-to-refresh
- [ ] Cache stock data for offline viewing via cacheData()

---

## Execution Strategy

- Phase 1+2 can be done in 1 session (forms only, backend ready)
- Phase 3 requires separate session (new backend entities + migration)
- Phase 4 is low priority, can be deferred
- Phase 5 can run in parallel with Phase 1+2 (independent frontend)

## Agent Orchestration

| Phase | Implementation Agents | Review Agent |
|-------|----------------------|--------------|
| 1+2 | 2x coder (modal components + tab wiring) | 1x reviewer |
| 3.1-3.2 | 1x backend-dev (entity + CQRS) | 1x reviewer |
| 3.3 | 1x coder (frontend hooks + components) | 1x reviewer |
| 5 | 1x mobile-dev (AquaMobil pages + offline) | 1x reviewer |
