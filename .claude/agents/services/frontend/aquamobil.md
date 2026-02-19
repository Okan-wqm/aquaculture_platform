---
name: aquamobil
description: Knowledge base for the AquaMobil PWA frontend application
---

# AquaMobil Knowledge Base

## Overview

AquaMobil is a standalone Progressive Web App (PWA) for mobile field data entry. It is separate from the Module Federation shell — a fully independent Vite React app deployed at `/mobile`. Field workers use it to record mortality, cull, harvest, and feeding events offline, with automatic background sync when connectivity is restored. Uses Konsta UI for mobile-first components and idb-keyval for IndexedDB-based offline queue.

## Directory Structure

```
web/apps/aquamobil/src/
  main.tsx
  App.tsx               # Main router: ProtectedRoute + FeatureRoute guards
  vite-env.d.ts
  pages/
    LoginPage.tsx                    # Mobile login screen
    HomePage.tsx                     # Dashboard: tank cards + quick actions
    mortality/
      RecordMortalityPage.tsx        # Record mortality event form
    cull/
      RecordCullPage.tsx             # Record cull event form
    harvest/
      RecordHarvestPage.tsx          # Record harvest form
    feeding/
      RecordFeedingPage.tsx          # Record daily feeding actual amount
    schedule/
      MySchedulePage.tsx             # View personal work schedule
    sync/
      SyncStatusPage.tsx             # Offline queue status and manual sync trigger
    index.ts
  layouts/
    MobileLayout.tsx                 # Bottom navigation + content area
    index.ts
  components/
    cards/
      TankCard.tsx                   # Tank status card (biomass, capacity, status)
    InstallPrompt.tsx                # PWA install banner
    index.ts
  hooks/
    useAuth.tsx                      # Mobile-specific auth hook
    useTanks.ts                      # Fetch tank list for current user's farm
    useOfflineQueue.tsx              # Offline queue state + sync management
    useMobilePermissions.ts          # Feature permission checks per user role
    useNetworkStatus.ts              # Online/offline detection
    useMySchedule.ts                 # Fetch user's work schedule
    index.ts
  pwa/
    offline-queue.ts                 # IndexedDB queue operations via idb-keyval
  graphql/
    operations.ts                    # All GraphQL query/mutation strings
  types/
    index.ts                         # All TypeScript type definitions
```

## Pages / Components

### HomePage (`/`)
- Fetches tank list via `useTanks()`
- Renders `TankCard` grid for each tank
- Each card shows: name, code, volume, status badge, currentBiomass/maxBiomass, batchMetrics (fish count, avg weight, density, capacity %)
- Quick action buttons navigate to record pages: Mortality, Cull, Harvest, Feeding
- Network status indicator (online/offline)

### RecordMortalityPage (`/mortality/record` and `/mortality/record/:tankId`)
- Selects tank (pre-selected if tankId in URL)
- Fields: quantity, reason (from `MortalityReason` enum), detail (free text), observedAt (datetime), avgWeightG, notes
- On submit: if online → GraphQL mutation directly; if offline → `queueOperation('recordMortality', payload)`

### RecordCullPage (`/cull/record` and `/cull/record/:tankId`)
- Similar to mortality but with `CullReason` enum and culledAt field

### RecordHarvestPage (`/harvest/record` and `/harvest/record/:tankId`)
- Fields: quantityHarvested, averageWeight, totalBiomass, qualityGrade (`QualityGrade` enum: PREMIUM/GRADE_A/B/C/REJECT), harvestDate, pricePerKg, buyerName, lotNumber, notes

### RecordFeedingPage (`/feeding/record` and `/feeding/record/:tankId`)
- Shows planned feeding amount from the daily feeding program
- Fields: executionId (selected from daily plan), actualKg, feedingMethod, feederEquipmentId, notes
- Queues `recordFeeding` operation when offline

### SyncStatusPage (`/sync`)
- Shows pending queue count, list of queued operations with type/status/timestamp
- "Sync Now" button triggers `syncAllOperations()`
- Shows success/failed counts from last sync attempt
- Operations that failed 3+ times are shown as permanently failed

### MySchedulePage (`/schedule`)
- Shows user's work schedule from HR module
- Shift cards with date, start/end time, location

### MobileLayout
- Bottom tab navigation: Home, Schedule, Sync, (possibly more)
- Responsive content area for page content

## State Management

### useAuth (`hooks/useAuth.tsx`)
- Reads JWT from `localStorage` (same storage as desktop shell: `access_token`, `refresh_token`, `tenant_id`)
- Decodes JWT to get user info (same approach as shell's MF fallback)
- `isAuthenticated`, `isLoading`, `login(email, password)`, `logout()`

### useOfflineQueue (`hooks/useOfflineQueue.tsx`)
- Wraps `pwa/offline-queue.ts` functions
- Returns: `pendingCount`, `pendingOperations`, `isOnline`, `isSyncing`, `syncNow()`, `clearQueue()`
- Listens to `online`/`offline` browser events via `useNetworkStatus`
- Auto-triggers sync when network comes back online

### useMobilePermissions (`hooks/useMobilePermissions.ts`)
- Returns `{ canAccess(feature: MobileFeature) => boolean, isLoaded: boolean }`
- `MobileFeature` type: `'mortality' | 'cull' | 'harvest' | 'feeding' | 'schedule'`
- Checks user role/permissions — `FeatureRoute` in App.tsx uses this to guard pages

### useNetworkStatus (`hooks/useNetworkStatus.ts`)
- Wraps `navigator.onLine` + `online`/`offline` events
- Returns `{ isOnline: boolean }`

## Offline Queue (`pwa/offline-queue.ts`)

Uses `idb-keyval` (IndexedDB wrapper) for persistence:

- **Queue operations** (`QUEUE_PREFIX = 'pending_'`):
  - `queueOperation(type, payload)` — writes to IndexedDB, registers background sync if available
  - `getPendingOperations()` — returns sorted pending list
  - `getPendingCount()` — count of pending keys
  - `updateOperation(id, updates)` — update status/retryCount
  - `removeOperation(id)` — remove after successful sync
  - `clearAllOperations()` — clear entire queue

- **Cache operations** (`CACHE_PREFIX = 'cache_'`):
  - `cacheData(key, data, ttlMs)` — cache tank/batch data with TTL (default 1 hour)
  - `getCachedData(key)` — returns cached data or null if expired
  - `clearCache()`

- **Sync**:
  - `syncOperation(operation, executeGraphQL)` — executes one operation, removes on success, marks failed on error
  - `syncAllOperations(executeGraphQL)` — iterates all pending, skips if `retryCount >= 3`, returns `{success, failed}`
  - Background Sync API registration via `navigator.serviceWorker.ready.sync.register('sync-operations')`

## GraphQL Operations (`graphql/operations.ts`)

```graphql
query Tanks($tenantId, $schemaName) {
  tanks { id name code volume status currentBiomass maxBiomass
    batchMetrics { batchId batchNumber pieces avgWeight biomass density capacityUsedPercent isOverCapacity daysSinceStocking } }
}

mutation RecordMortality($tenantId, $schemaName, $input: MortalityInput!) {
  recordMortality { id quantity reason observedAt }
}

mutation RecordCull($tenantId, $schemaName, $input: CullInput!) {
  recordCull { id quantity reason culledAt }
}

mutation CreateHarvestRecord($tenantId, $schemaName, $input: HarvestInput!) {
  createHarvestRecord { id quantityHarvested averageWeight totalBiomass qualityGrade }
}

mutation RecordFeeding($tenantId, $schemaName, $input: FeedingInput!) {
  recordFeeding { id executionId actualKg }
}

query MySchedule($employeeId, $weekStart) {
  mySchedule { date shiftType startTime endTime siteId siteName }
}
```

## Routing

```
/login             -> LoginPage (public)
/                  -> HomePage (protected)
/mortality/record  -> RecordMortalityPage (feature: mortality)
/mortality/record/:tankId -> RecordMortalityPage (feature: mortality)
/cull/record       -> RecordCullPage (feature: cull)
/cull/record/:tankId -> RecordCullPage (feature: cull)
/harvest/record    -> RecordHarvestPage (feature: harvest)
/harvest/record/:tankId -> RecordHarvestPage (feature: harvest)
/feeding/record    -> RecordFeedingPage (feature: feeding)
/feeding/record/:tankId -> RecordFeedingPage (feature: feeding)
/schedule          -> MySchedulePage (feature: schedule)
/sync              -> SyncStatusPage (always accessible)
```

## Key Dependencies

- `idb-keyval` — IndexedDB wrapper for offline queue and data cache
- Konsta UI — mobile-first UI components (Capacitor/Ionic compatible)
- Vite PWA plugin — service worker, offline support
- Workbox — precaching, background sync
- `react-router-dom` v6
- Tailwind CSS

## Known Gotchas

- AquaMobil is a **completely separate Vite app**, not part of Module Federation. It has its own build pipeline, package.json, and deployment.
- Auth tokens are shared with the desktop shell via `localStorage` (`access_token`, `refresh_token`, `tenant_id`) — same keys, no SSO ceremony needed if already logged in on the same domain.
- **OperationType** enum: `'recordMortality' | 'recordCull' | 'createHarvestRecord' | 'recordFeeding'` — must match backend GraphQL mutation names exactly for offline sync dispatch.
- Max retry count is **3** — operations that fail 3 times are permanently stuck in queue until manually cleared. No automatic clearing.
- Background Sync API (`SyncManager`) is not available in all browsers (mainly Chrome/Android). Fallback: manual sync from `SyncStatusPage`.
- `cacheData` TTL defaults to 1 hour — cached tank data shown to user when offline may be stale.
- `useMobilePermissions` is the feature gate — `FeatureRoute` redirects to `/` if `canAccess(feature)` returns false.
- The `package-lock.json` for aquamobil is untracked (in git status `??`) — this is a separate npm project.
- `FeedingInput.executionId` is required — the user must select a specific daily feeding execution from the plan, not just pick a tank.

## Related Backend Services

- **farm-service** (port 3002 dev) — tank data, mortality, cull, harvest, feeding records
- **hr-service** — schedule data via `mySchedule` query
- **gateway-api** (port 3000) — all GraphQL requests
