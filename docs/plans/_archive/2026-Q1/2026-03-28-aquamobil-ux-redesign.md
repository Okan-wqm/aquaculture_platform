# AquaMobil UX Redesign Plan

**Date:** 2026-03-28
**Status:** Draft
**Target:** Enterprise-grade mobile PWA for aquaculture field operations
**Benchmark:** AKVA Group Connect, InnovaSea Realtime Aquaculture, Aqua-Manager Mobile

---

## Executive Summary

AquaMobil is a 24-page React PWA serving aquaculture field workers, managers, and warehouse operators. The current implementation has strong foundations (lazy loading, offline queue, RBAC via 12 feature permissions, AI insights, biometric auth) but suffers from navigation redundancy, missing user identity surfaces, dead dark mode code, and inconsistent component patterns. This plan addresses these gaps with a phased redesign that maintains backward compatibility and introduces zero new dependencies.

---

## 1. Navigation Architecture Redesign

### Current State

5 bottom tabs: **Home | Record | Tasks | HR | More**

Problems identified from the codebase:
- Home page `allQuickActions` array (9 items) duplicates RecordHubPage `allActions` array (7 items) -- same feature paths, different gradient colors
- Record tab mixes farm operations (feeding, mortality, cull, harvest, transfer, water quality) with warehouse operations (storage) in a flat grid
- HR tab is a dedicated tab for only 3 items (attendance, leave, schedule) -- low information density
- "More" page has only 4 items (sync, notifications, biometric, logout) -- underutilized real estate
- No back navigation on RecordHubPage, HrHubPage, MyTasksPage (only TankDetailPage, NotificationsPage, and RecordFeedingPage have ArrowLeft)

### Proposed Structure: 4 Tabs

```
Home  |  Operations  |  Tasks  |  Account
```

**Rationale for reducing to 4 tabs:**
- Fitts's Law: fewer, wider tap targets improve accuracy on a rocking boat
- HR actions (clock-in, leave) are low-frequency compared to feeding/mortality; they belong in Operations under a "Staff" sub-group
- "Account" replaces "More" with a proper profile/settings destination
- 4 tabs align with iOS HIG and Material Design recommendations for mobile-first apps

### Tab 1: Home (Dashboard)
- Path: `/`
- Icon: `Home` (lucide)
- Active color: `text-ocean-600` / `bg-ocean-50`
- Purpose: Operational dashboard -- read-only summary, alerts, AI insights
- No quick action buttons (those move to Operations tab)

### Tab 2: Operations (replaces Record)
- Path: `/operations`
- Icon: `ClipboardList` (lucide)
- Active color: `text-orange-600` / `bg-orange-50`
- Purpose: All data entry and operational actions
- Feature guard: shows if ANY of `['feeding', 'mortality', 'cull', 'harvest', 'transfer', 'waterQuality', 'storage', 'attendance', 'leave', 'schedule']`
- Sub-grouped layout (see Section 4)

### Tab 3: Tasks
- Path: `/tasks`
- Icon: `CheckSquare` (lucide)
- Active color: `text-green-600` / `bg-green-50`
- Feature guard: `['tasks']`
- No changes to internal structure

### Tab 4: Account (replaces More)
- Path: `/account`
- Icon: `UserCircle` (lucide)
- Active color: `text-gray-600` / `bg-gray-100`
- Purpose: Profile, settings, sync, notifications, logout
- Always visible (no feature guard)

### Tab Definition Changes

**File:** `web/apps/aquamobil/src/layouts/MobileLayout.tsx`

Replace the `allTabs` array:

```typescript
const allTabs: TabItem[] = [
  {
    id: 'home',
    icon: Home,
    label: 'Home',
    path: '/',
    activeColor: 'text-ocean-600',
    activeBg: 'bg-ocean-50 dark:bg-ocean-900/30',
  },
  {
    id: 'operations',
    icon: ClipboardList,
    label: 'Operations',
    path: '/operations',
    activeColor: 'text-orange-600',
    activeBg: 'bg-orange-50 dark:bg-orange-900/30',
    features: [
      'feeding', 'mortality', 'cull', 'harvest', 'transfer',
      'waterQuality', 'storage', 'attendance', 'leave', 'schedule',
    ],
  },
  {
    id: 'tasks',
    icon: CheckSquare,
    label: 'Tasks',
    path: '/tasks',
    activeColor: 'text-green-600',
    activeBg: 'bg-green-50 dark:bg-green-900/30',
    features: ['tasks'],
  },
  {
    id: 'account',
    icon: UserCircle,
    label: 'Account',
    path: '/account',
    activeColor: 'text-gray-600',
    activeBg: 'bg-gray-100 dark:bg-gray-800',
  },
];
```

### Badge Logic Update

```typescript
const getBadge = (tabId: string): number => {
  if (tabId === 'account') return pendingCount + unreadCount;
  if (tabId === 'tasks') return todayTaskCount; // new: show today's task count
  return 0;
};
```

This requires adding `useMyTasks('today')` to MobileLayout. To avoid unnecessary fetches, wrap it in a conditional that only calls the hook when the tasks tab is visible.

### Route Updates

**File:** `web/apps/aquamobil/src/App.tsx`

```
/record        -> /operations       (redirect /record -> /operations for bookmarks)
/hr            -> removed           (HR items are sub-groups in /operations)
/more          -> /account          (redirect /more -> /account for bookmarks)
```

Add redirect routes for backward compatibility:
```typescript
<Route path="/record" element={<Navigate to="/operations" replace />} />
<Route path="/hr" element={<Navigate to="/operations" replace />} />
<Route path="/more" element={<Navigate to="/account" replace />} />
```

---

## 2. Profile and Settings Page

### Current State

The MorePage (`web/apps/aquamobil/src/pages/more/MorePage.tsx`) has:
- No user identity display (name, role, email, tenant are absent)
- Menu items: Synchronization, Notifications, Biometric Login, Log Out
- No dark mode toggle
- No app version or cache management

### Proposed: AccountPage

**New file:** `web/apps/aquamobil/src/pages/account/AccountPage.tsx`

This replaces MorePage. The MorePage file will be kept but the route `/more` redirects to `/account`.

### Layout Structure

```
+--------------------------------------------+
|  Gradient Header (ocean)                   |
|  "Account"                                 |
+--------------------------------------------+
|                                            |
|  [Avatar Circle]  John Smith               |
|                   Operator                  |
|                   AquaFarm Istanbul         |
|                   john@example.com          |
|                                            |
+--------------------------------------------+
|  PREFERENCES                               |
|  [Moon]  Dark Mode          [Toggle]       |
|  [Globe] Language           English >      |
+--------------------------------------------+
|  APP                                       |
|  [Cloud]       Sync Status    (3) >        |
|  [Bell]        Notifications  (5) >        |
|  [Fingerprint] Biometric      Enabled >    |
+--------------------------------------------+
|  SYSTEM                                    |
|  [HardDrive] Storage          12.3 MB >    |
|  [Trash]     Clear Cache                   |
|  [Info]      About            v2.4.0       |
+--------------------------------------------+
|  [LogOut]    Log Out                       |
+--------------------------------------------+
```

### User Profile Card

The user data is already available from `useAuth()`:
- `user.name` -- display name (firstName + lastName)
- `user.email` -- email address
- `user.role` -- SUPER_ADMIN | TENANT_ADMIN | MANAGER | OPERATOR | VIEWER
- `user.tenantId` -- tenant context

For the avatar, generate initials from `user.name`:
```typescript
const initials = user.name
  .split(' ')
  .map((w) => w[0])
  .join('')
  .toUpperCase()
  .slice(0, 2);
```

Role display mapping:
```typescript
const ROLE_LABELS: Record<string, { label: string; color: string }> = {
  SUPER_ADMIN:  { label: 'Super Admin',  color: 'bg-red-100 text-red-700' },
  TENANT_ADMIN: { label: 'Admin',        color: 'bg-purple-100 text-purple-700' },
  MANAGER:      { label: 'Manager',      color: 'bg-blue-100 text-blue-700' },
  OPERATOR:     { label: 'Operator',     color: 'bg-green-100 text-green-700' },
  VIEWER:       { label: 'Viewer',       color: 'bg-gray-100 text-gray-700' },
};
```

Tenant name is not currently fetched on the mobile side. For phase 1, display `tenantId` with a label "Tenant" or omit it. Phase 2 can add a `tenantName` field to the login/refresh GraphQL response.

### Dark Mode Toggle

The Tailwind config already uses `darkMode: 'class'` and all components have `dark:` variants. The CSS is fully written but there is no toggle -- the `dark` class is never added to `<html>`.

Implementation:

```typescript
// web/apps/aquamobil/src/hooks/useDarkMode.ts

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'aquamobil_dark_mode';

type DarkModePreference = 'light' | 'dark' | 'system';

export function useDarkMode() {
  const [preference, setPreference] = useState<DarkModePreference>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });

  const applyTheme = useCallback((pref: DarkModePreference) => {
    const isDark =
      pref === 'dark' ||
      (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    document.documentElement.classList.toggle('dark', isDark);
  }, []);

  useEffect(() => {
    applyTheme(preference);
    localStorage.setItem(STORAGE_KEY, preference);
  }, [preference, applyTheme]);

  // Listen for OS theme changes when preference is 'system'
  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [preference, applyTheme]);

  const toggle = useCallback(() => {
    setPreference((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const isDark =
    preference === 'dark' ||
    (preference === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return { isDark, preference, setPreference, toggle };
}
```

The toggle must also be initialized on app startup. Add to `App.tsx` or `main.tsx`:

```typescript
// Initialize dark mode from localStorage before first paint
const stored = localStorage.getItem('aquamobil_dark_mode');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
if (stored === 'dark' || (stored !== 'light' && prefersDark)) {
  document.documentElement.classList.add('dark');
}
```

This must execute synchronously before React renders to avoid a flash of wrong theme.

### Storage Usage Display

Calculate offline queue size from IndexedDB:
```typescript
const storageEstimate = navigator.storage?.estimate
  ? await navigator.storage.estimate()
  : null;
const usageMB = storageEstimate
  ? (storageEstimate.usage ?? 0) / (1024 * 1024)
  : null;
```

### Cache Clear Action

Reuse the existing `clearCache` and `clearAllOperations` from `web/apps/aquamobil/src/pwa/offline-queue.ts`:
```typescript
import { clearAllOperations, clearCache } from '@/pwa/offline-queue';
```

### App Version

Read from `import.meta.env.VITE_APP_VERSION` or hardcode in vite.config.ts via `define`:
```typescript
define: {
  __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0'),
}
```

---

## 3. Home Page Redesign

### Current State

`web/apps/aquamobil/src/pages/HomePage.tsx` (350 lines) contains:
1. Gradient header with user name + notification bell + logout button
2. 4-column stats row (Tanks, Batches, Total Fish, Pending Sync)
3. Over-capacity alert banner
4. Task alert banner (pending tasks today)
5. Quick Actions grid (9 items -- duplicates Record tab)
6. Farm Summary card (Total Fish, Biomass, Capacity)
7. AI Insights card
8. Tanks list with TankCard components

**Problems:**
- Quick Actions grid is identical to the Operations tab -- users have two paths to the same destination
- 7 sections on one page creates excessive scroll depth
- Stats row (item 2) and Farm Summary (item 6) show overlapping data (Total Fish appears in both)
- Logout button in the header is redundant with the Account page

### Proposed: Focused Dashboard

Remove all action entry points. The Home tab becomes read-only intelligence.

```
+--------------------------------------------+
|  Gradient Header                           |
|  [Fish] AquaMobil        [Bell] [Avatar]  |
|         Good morning, John                 |
|                                            |
|  [Tanks] [Batches] [Fish] [Pending]       |
+--------------------------------------------+
|                                            |
|  ! 2 tanks over capacity (if any)          |
|  ! 3 tasks waiting for you today (if any)  |
|                                            |
|  AI INSIGHTS (compact)                     |
|  [Risk Gauge] Overall Risk: 32 Low         |
|  [Feeding Tip] ...                         |
|                                            |
|  TANKS (12)                                |
|  [TankCard] Tank A-01                      |
|  [TankCard] Tank A-02                      |
|  ...                                       |
+--------------------------------------------+
```

### Changes

**Removed:**
- Quick Actions grid (`allQuickActions` array + rendering block)
- Farm Summary card (redundant with header stats)
- Logout button from header (moved to Account page)

**Added:**
- Avatar button in header (navigates to `/account`)
- Time-based greeting ("Good morning" / "Good afternoon" / "Good evening")
- Date display (e.g., "Friday, March 28")

**Kept:**
- Gradient header with stats row
- Over-capacity alert banner
- Task alert banner
- AI Insights card (no changes needed -- already compact and well-designed)
- Tanks list with TankCard

### Header Modification

Replace the logout button with an avatar that navigates to `/account`:

```typescript
<button
  onClick={() => navigate('/account')}
  className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-full flex items-center justify-center text-sm font-bold"
>
  {initials}
</button>
```

### Greeting Logic

```typescript
const getGreeting = (): string => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

const formatDate = (): string => {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
};
```

### Estimated Line Reduction

Current: ~350 lines. After removing Quick Actions (35 lines) and Farm Summary (35 lines): ~280 lines.

---

## 4. Operations Hub Restructure

### Current State

`web/apps/aquamobil/src/pages/record/RecordHubPage.tsx` (83 lines) shows a flat 2-column grid of 7 operation cards:
- Feeding, Water Quality, Mortality Record, Culling, Harvest, Transfer, Storage

All items are farm-related except Storage (warehouse). There is no visual grouping.

### Proposed: Grouped Operations Hub

**New file:** `web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx`

Replaces RecordHubPage. The `/record` route redirects to `/operations`.

### Layout

```
+--------------------------------------------+
|  Gradient Header (orange)                  |
|  [<] Operations                            |
+--------------------------------------------+
|                                            |
|  DAILY OPERATIONS                          |
|  [Feeding]  [Water Quality]                |
|                                            |
|  STOCK EVENTS                              |
|  [Mortality]  [Culling]                    |
|  [Harvest]    [Transfer]                   |
|                                            |
|  WAREHOUSE                                 |
|  [Storage]                                 |
|                                            |
|  STAFF                                     |
|  [Clock In]  [Leave]  [Shift Schedule]     |
|                                            |
+--------------------------------------------+
```

### Group Definitions

```typescript
interface OperationGroup {
  id: string;
  title: string;
  items: OperationItem[];
}

interface OperationItem {
  feature: MobileFeature;
  path: string;
  icon: typeof Utensils;
  label: string;
  gradient: string;
}

const operationGroups: OperationGroup[] = [
  {
    id: 'daily',
    title: 'Daily Operations',
    items: [
      { feature: 'feeding', path: '/feeding/record', icon: Utensils, label: 'Feeding', gradient: 'from-green-500 to-green-600' },
      { feature: 'waterQuality', path: '/water-quality/record', icon: Droplets, label: 'Water Quality', gradient: 'from-cyan-500 to-blue-500' },
    ],
  },
  {
    id: 'stock',
    title: 'Stock Events',
    items: [
      { feature: 'mortality', path: '/mortality/record', icon: Skull, label: 'Mortality', gradient: 'from-red-500 to-red-600' },
      { feature: 'cull', path: '/cull/record', icon: Scissors, label: 'Culling', gradient: 'from-amber-500 to-amber-600' },
      { feature: 'harvest', path: '/harvest/record', icon: Package, label: 'Harvest', gradient: 'from-violet-500 to-violet-600' },
      { feature: 'transfer', path: '/transfer/record', icon: ArrowLeftRight, label: 'Transfer', gradient: 'from-blue-500 to-blue-600' },
    ],
  },
  {
    id: 'warehouse',
    title: 'Warehouse',
    items: [
      { feature: 'storage', path: '/storage', icon: Warehouse, label: 'Storage', gradient: 'from-teal-500 to-teal-600' },
    ],
  },
  {
    id: 'staff',
    title: 'Staff',
    items: [
      { feature: 'attendance', path: '/attendance', icon: MapPin, label: 'Clock In', gradient: 'from-emerald-500 to-emerald-600' },
      { feature: 'leave', path: '/leave', icon: CalendarOff, label: 'Leave', gradient: 'from-indigo-500 to-indigo-600' },
      { feature: 'schedule', path: '/schedule', icon: Clock, label: 'Shift', gradient: 'from-purple-500 to-purple-600' },
    ],
  },
];
```

### Rendering Logic

Each group only renders if at least one item in the group passes `canAccess()`. Items within a group are individually filtered.

```typescript
{operationGroups.map((group) => {
  const visibleItems = group.items.filter((item) => canAccess(item.feature));
  if (visibleItems.length === 0) return null;

  return (
    <div key={group.id} className="mb-6">
      <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 px-1">
        {group.title}
      </h2>
      <div className="grid grid-cols-2 gap-3">
        {visibleItems.map((item) => (
          <OperationCard key={item.feature} item={item} />
        ))}
      </div>
    </div>
  );
})}
```

### Field Worker Priority

The grouping order reflects field worker frequency:
1. **Daily Operations** (feeding + WQ) -- performed multiple times per day
2. **Stock Events** (mortality, cull, harvest, transfer) -- performed as-needed
3. **Warehouse** -- performed by warehouse staff, less frequent for field workers
4. **Staff** -- clock-in/out at shift start/end

---

## 5. Component Consistency

### 5.1 SyncStatusPage Konsta Component Replacement

**File:** `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`

**Current:** Uses `Navbar`, `Block`, `BlockTitle`, `Button`, `List`, `ListItem` from `konsta/react`. This is the only page in the app still using Konsta layout components directly (other pages like RecordFeedingPage use Konsta form components like `ListInput`, which is acceptable).

**Target:** Replace with custom Tailwind components matching the design language of other pages.

Specific replacements:

| Konsta Component | Replacement |
|---|---|
| `<Navbar title="Sync Status" />` | Gradient header with ArrowLeft back button (same pattern as NotificationsPage) |
| `<Block>` | `<div className="px-5 pt-4">` |
| `<BlockTitle>` | `<h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 px-5">` |
| `<Button>` | Custom button with gradient + shadow (same pattern as form submit buttons) |
| `<List>` / `<ListItem>` | Custom card list with `bg-white dark:bg-gray-900 rounded-2xl shadow-card border` |

After this change, `konsta/react` imports in this file drop to zero. The file can fully remove the konsta layout dependency.

### 5.2 Gradient Header Standardization

Pages that are missing the gradient header or have inconsistent headers:

| Page | Current Header | Target |
|---|---|---|
| SyncStatusPage | Konsta `<Navbar>` (flat, no gradient) | Ocean gradient with ArrowLeft |
| RecordFeedingPage | Green gradient (has ArrowLeft) | Keep -- operation-specific color is intentional |
| RecordMortalityPage | Assumed similar to Feeding | Verify consistency |
| RecordCullPage | Assumed similar to Feeding | Verify consistency |
| RecordHarvestPage | Assumed similar to Feeding | Verify consistency |
| RecordTransferPage | Assumed similar to Feeding | Verify consistency |
| WaterQualityRecordPage | Assumed similar to Feeding | Verify consistency |

Hub pages (OperationsHub, TasksPage, AccountPage) use the standard ocean gradient.
Detail/form pages use operation-specific gradients (green for feeding, red for mortality, etc.).
All pages must have the curved SVG bottom edge.

### 5.3 Back Navigation

Pages currently missing back button (ArrowLeft in header):

| Page | Fix |
|---|---|
| RecordHubPage (now OperationsHubPage) | Not needed -- it is a tab root |
| HrHubPage | Absorbed into OperationsHubPage |
| MyTasksPage | Not needed -- it is a tab root |
| StorageHubPage | Add ArrowLeft, navigate(-1) |
| StockMovementPage | Verify -- should have ArrowLeft |
| StockTransferPage | Verify -- should have ArrowLeft |
| StockViewPage | Verify -- should have ArrowLeft |
| SyncStatusPage | Add ArrowLeft (part of Konsta replacement) |
| AttendancePage | Verify |
| MySchedulePage | Verify |
| MyLeavesPage | Verify |
| LeaveRequestPage | Verify |

Rule: Tab root pages (Home, Operations, Tasks, Account) do NOT have back buttons. All other pages (reached via navigation from a tab root) MUST have an ArrowLeft back button.

### 5.4 Skeleton Loaders

The `skeleton` CSS class is already defined in `main.css`. The following pages use it correctly:
- HomePage (tank list loading state)
- MyTasksPage (task list loading state)
- TankDetailPage (detail loading state)
- AiInsightsCard (loading state)

Pages that need skeleton loaders added:

| Page | Loading State Needed |
|---|---|
| AttendancePage | Attendance record list |
| MyLeavesPage | Leave request list |
| MySchedulePage | Schedule calendar/list |
| StorageHubPage | No data fetch -- not needed |
| StockViewPage | Stock inventory list |
| NotificationsPage | Already has skeleton |
| SyncStatusPage | Queue list (currently no loading state) |

Pattern to follow (from MyTasksPage):
```typescript
{loading ? (
  <div className="space-y-3">
    {[1, 2, 3].map((i) => (
      <div key={i} className="h-24 rounded-2xl skeleton" />
    ))}
  </div>
) : ( /* content */ )}
```

---

## 6. Dark Mode Activation

### Current State

- `tailwind.config.js` line 6: `darkMode: 'class'`
- Every component has `dark:` Tailwind variants (verified across all 36 TSX files)
- `main.css` has `.dark .glass` override
- The `dark` class is never toggled on `<html>` -- all dark variants are dead code

### Implementation Plan

#### Step 1: Create useDarkMode Hook

**New file:** `web/apps/aquamobil/src/hooks/useDarkMode.ts`

See Section 2 for the full implementation. Key behaviors:
- Default: `'system'` (respects OS preference via `prefers-color-scheme`)
- Persists to `localStorage` under key `aquamobil_dark_mode`
- Applies by toggling `document.documentElement.classList`

#### Step 2: Prevent Flash of Incorrect Theme

**File:** `web/apps/aquamobil/index.html`

Add an inline script in the `<head>` before any CSS or JS loads:

```html
<script>
  (function() {
    var s = localStorage.getItem('aquamobil_dark_mode');
    var d = s === 'dark' || (s !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (d) document.documentElement.classList.add('dark');
  })();
</script>
```

This executes synchronously during HTML parsing, before the first paint.

#### Step 3: Wire Toggle to Account Page

In AccountPage, the Preferences section includes a toggle switch:

```typescript
const { isDark, toggle } = useDarkMode();

// In JSX:
<button
  onClick={toggle}
  className={clsx(
    'w-12 h-7 rounded-full transition-colors duration-200 relative',
    isDark ? 'bg-ocean-500' : 'bg-gray-300',
  )}
>
  <span
    className={clsx(
      'absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform duration-200',
      isDark ? 'translate-x-5' : 'translate-x-0',
    )}
  />
</button>
```

#### Step 4: Konsta Theme Sync

Konsta UI uses its own theming. The `konstaConfig` wrapper in tailwind.config.js should auto-handle dark variants, but verify that Konsta's `<Page>` component (used in MobileLayout) respects the `dark` class. If not, add `dark` prop to Konsta's `<App>` wrapper or remove the Konsta `<Page>` wrapper in favor of a plain `<div>`.

**Current MobileLayout line 94:** `<Page className="pb-safe">`

If Konsta's Page does not respect Tailwind dark mode, replace with:
```typescript
<div className="flex flex-col min-h-screen pb-safe bg-gray-50 dark:bg-gray-950">
```

---

## 7. Tank Card Improvement

### Current State

`web/apps/aquamobil/src/components/cards/TankCard.tsx` (215 lines):
- Gradient header (clickable, navigates to `/tank/:id`)
- 3-column stats grid (Fish, Avg Wt, Biomass)
- Capacity progress bar
- Bottom action row: up to 4 inline buttons (Mortality, Cull, Harvest, Transfer)

**Problems:**
- 4 action buttons create a cluttered bottom row, especially on narrow screens (320px width)
- Buttons are small (15px icons + 12px text) -- difficult to tap with wet/gloved hands
- All 4 actions are always visible if the user has permissions -- no prioritization

### Proposed: Context Menu Pattern

Replace the inline bottom action row with a 3-dot context menu.

#### Option A: Bottom Sheet (Recommended)

Tapping the 3-dot button opens a bottom sheet with large (48px height) action rows:

```
+--------------------------------------------+
|  Tank A-01                    ...          |
|  [Fish: 12.5K] [Avg: 450g] [Bio: 5.6t]   |
|  Capacity: [========= ] 78%               |
+--------------------------------------------+

  // On "..." tap:

+--------------------------------------------+
|  Tank A-01 Actions              [X]        |
|                                            |
|  [Skull]     Record Mortality              |
|  [Scissors]  Record Culling                |
|  [Package]   Record Harvest                |
|  [Arrows]    Record Transfer               |
|  [Droplets]  Water Quality                 |
|  [Utensils]  Record Feeding                |
+--------------------------------------------+
```

#### Implementation

**New component:** `web/apps/aquamobil/src/components/TankActionSheet.tsx`

```typescript
interface TankActionSheetProps {
  tank: Tank;
  isOpen: boolean;
  onClose: () => void;
}
```

Uses a portal-based bottom sheet with:
- Backdrop overlay (click to dismiss)
- Slide-up animation (existing `animate-slide-up` class from main.css)
- Large touch targets (min 48px height per row, per WCAG 2.5.8)
- Feature-gated action rows (only show actions the user has permission for)

#### TankCard Changes

**File:** `web/apps/aquamobil/src/components/cards/TankCard.tsx`

Remove the entire bottom action row (`<div className="flex border-t ...">` block, lines 172-211).

Add a 3-dot button to the card header:

```typescript
<button
  onClick={(e) => {
    e.stopPropagation();
    setShowActions(true);
  }}
  className="p-2 rounded-lg bg-white/10 touch-feedback"
>
  <MoreVertical size={18} className="text-white" />
</button>
```

#### Swipe-to-Action (Phase 2)

Swipe gestures require a touch gesture library (e.g., `@use-gesture/react`). This is a Phase 2 enhancement. For Phase 1, the context menu provides the same functionality with simpler implementation and better accessibility.

### Estimated Line Impact

TankCard: remove ~40 lines of inline buttons, add ~5 lines for context menu trigger. Net reduction: ~35 lines.
New TankActionSheet: ~80 lines.

---

## 8. Implementation Tasks

Each task is a discrete commit. Tasks are ordered by dependency -- later tasks may depend on earlier ones.

### Phase 1: Foundation (Week 1)

#### Task 1.1: Create useDarkMode Hook
- **Create:** `web/apps/aquamobil/src/hooks/useDarkMode.ts`
- **Edit:** `web/apps/aquamobil/index.html` (add inline dark mode script in `<head>`)
- **Edit:** `web/apps/aquamobil/src/hooks/index.ts` (export new hook)
- **Test:** Toggle dark class on `<html>`, verify localStorage persistence, verify OS preference detection
- **Scope:** Small, no UI changes yet

#### Task 1.2: Create AccountPage with Profile Card
- **Create:** `web/apps/aquamobil/src/pages/account/AccountPage.tsx`
- **Edit:** `web/apps/aquamobil/src/App.tsx` (add `/account` route, lazy import)
- **Edit:** `web/apps/aquamobil/src/pages/index.ts` (export AccountPage)
- **Dependencies:** Task 1.1 (useDarkMode hook for toggle)
- **Content:** User profile card (avatar initials, name, email, role badge, tenant), dark mode toggle, menu items (sync, notifications, biometric, cache clear, about, logout)
- **Scope:** Medium -- reuses patterns from MorePage

#### Task 1.3: Create OperationsHubPage with Grouped Layout
- **Create:** `web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx`
- **Edit:** `web/apps/aquamobil/src/App.tsx` (add `/operations` route, lazy import)
- **Edit:** `web/apps/aquamobil/src/pages/index.ts` (export OperationsHubPage)
- **Content:** 4 groups (Daily Operations, Stock Events, Warehouse, Staff) with feature-gated items
- **Scope:** Medium -- follows RecordHubPage pattern with added grouping

#### Task 1.4: Update Navigation Tabs (4-tab layout)
- **Edit:** `web/apps/aquamobil/src/layouts/MobileLayout.tsx` (replace `allTabs` array, update imports, add `UserCircle` icon)
- **Edit:** `web/apps/aquamobil/src/App.tsx` (add redirect routes for `/record`, `/hr`, `/more`)
- **Dependencies:** Task 1.2, Task 1.3
- **Scope:** Small -- config change in tab definitions

### Phase 2: Home Page + Consistency (Week 2)

#### Task 2.1: Redesign Home Page as Dashboard
- **Edit:** `web/apps/aquamobil/src/pages/HomePage.tsx`
- **Remove:** Quick Actions grid (lines 232-258), Farm Summary card (lines 261-297), logout button from header
- **Add:** Avatar button in header (navigates to `/account`), greeting with date, time-based greeting logic
- **Dependencies:** Task 1.2 (Account page must exist for avatar navigation)
- **Scope:** Medium -- mostly deletion + small additions

#### Task 2.2: Replace Konsta Components in SyncStatusPage
- **Edit:** `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- **Replace:** `Navbar` with gradient header + ArrowLeft, `Block` with `div`, `BlockTitle` with heading, `Button` with custom button, `List`/`ListItem` with custom card list
- **Remove:** All `konsta/react` imports from this file
- **Scope:** Medium -- full page rewrite maintaining same functionality

#### Task 2.3: Add Back Buttons to Sub-Pages
- **Edit:** `web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx` (add ArrowLeft header button)
- **Edit:** `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx` (verify/add ArrowLeft)
- **Edit:** `web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx` (verify/add ArrowLeft)
- **Edit:** `web/apps/aquamobil/src/pages/storage/StockViewPage.tsx` (verify/add ArrowLeft)
- **Edit:** `web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx` (verify/add ArrowLeft)
- **Edit:** `web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx` (verify/add ArrowLeft)
- **Edit:** `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx` (verify/add ArrowLeft)
- **Edit:** `web/apps/aquamobil/src/pages/schedule/MySchedulePage.tsx` (verify/add ArrowLeft)
- **Scope:** Small per file -- add 5-10 lines to each header

#### Task 2.4: Add Skeleton Loaders to Data-Fetching Pages
- **Edit:** `web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx` (add loading skeleton)
- **Edit:** `web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx` (add loading skeleton)
- **Edit:** `web/apps/aquamobil/src/pages/schedule/MySchedulePage.tsx` (add loading skeleton)
- **Edit:** `web/apps/aquamobil/src/pages/storage/StockViewPage.tsx` (add loading skeleton)
- **Edit:** `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx` (add loading skeleton for queue list)
- **Scope:** Small per file -- add existing `skeleton` CSS class pattern

### Phase 3: Tank Cards + Polish (Week 3)

#### Task 3.1: Create TankActionSheet Component
- **Create:** `web/apps/aquamobil/src/components/TankActionSheet.tsx`
- **Edit:** `web/apps/aquamobil/src/components/index.ts` (export TankActionSheet)
- **Content:** Bottom sheet with backdrop, slide-up animation, feature-gated action rows, large touch targets
- **Scope:** Medium -- new component

#### Task 3.2: Refactor TankCard to Use Context Menu
- **Edit:** `web/apps/aquamobil/src/components/cards/TankCard.tsx`
- **Remove:** Bottom action row (lines 172-211)
- **Add:** 3-dot menu button in header, state for sheet visibility, TankActionSheet integration
- **Dependencies:** Task 3.1
- **Scope:** Medium -- removes ~40 lines, adds ~15 lines

#### Task 3.3: Clean Up Old Pages
- **Delete or deprecate:** `web/apps/aquamobil/src/pages/record/RecordHubPage.tsx` (replaced by OperationsHubPage)
- **Delete or deprecate:** `web/apps/aquamobil/src/pages/hr/HrHubPage.tsx` (absorbed into OperationsHubPage)
- **Keep:** `web/apps/aquamobil/src/pages/more/MorePage.tsx` (redirect in App.tsx handles it, but keep file for backward compat until verified)
- **Edit:** `web/apps/aquamobil/src/App.tsx` (remove old lazy imports if pages are deleted)
- **Scope:** Small -- file cleanup

#### Task 3.4: Verify Konsta Page Wrapper with Dark Mode
- **Edit:** `web/apps/aquamobil/src/layouts/MobileLayout.tsx` (if Konsta `<Page>` does not respect `dark` class, replace with plain `<div>`)
- **Test:** Toggle dark mode, verify MobileLayout background switches correctly
- **Scope:** Small -- conditional fix

### Phase 4: Future Enhancements (Backlog)

These are documented for future sprints but not part of this immediate redesign.

#### Task 4.1: Global Search
- Add a search bar to the Home page header or a dedicated search page
- Fuzzy search across tanks, tasks, notifications
- Requires a new `useSearch` hook with local + server-side search

#### Task 4.2: Swipe-to-Action on Tank Cards
- Add `@use-gesture/react` dependency
- Implement swipe-left on TankCard to reveal quick actions
- Consider battery/performance impact on low-end Android devices

#### Task 4.3: Tenant Name in Profile
- Add `tenantName` field to the auth GraphQL login/refresh response
- Display in AccountPage profile card

#### Task 4.4: Language Preference
- Add `aquamobil_language` localStorage key
- Wire to i18n library (react-intl or react-i18next)
- Requires full string extraction pass across all 36 TSX files

#### Task 4.5: Replace Remaining Konsta Form Components
- RecordFeedingPage uses `List`, `ListInput`, `BlockTitle` from konsta/react
- Other record pages may use Konsta form components
- Replace with custom Tailwind form components for full design consistency

---

## 9. File Change Matrix

| File | Action | Task |
|---|---|---|
| `src/hooks/useDarkMode.ts` | CREATE | 1.1 |
| `src/hooks/index.ts` | EDIT | 1.1 |
| `index.html` | EDIT | 1.1 |
| `src/pages/account/AccountPage.tsx` | CREATE | 1.2 |
| `src/pages/index.ts` | EDIT | 1.2, 1.3 |
| `src/pages/operations/OperationsHubPage.tsx` | CREATE | 1.3 |
| `src/layouts/MobileLayout.tsx` | EDIT | 1.4 |
| `src/App.tsx` | EDIT | 1.2, 1.3, 1.4, 3.3 |
| `src/pages/HomePage.tsx` | EDIT | 2.1 |
| `src/pages/sync/SyncStatusPage.tsx` | EDIT | 2.2, 2.4 |
| `src/pages/storage/StorageHubPage.tsx` | EDIT | 2.3 |
| `src/pages/storage/StockMovementPage.tsx` | EDIT | 2.3 |
| `src/pages/storage/StockTransferPage.tsx` | EDIT | 2.3 |
| `src/pages/storage/StockViewPage.tsx` | EDIT | 2.3, 2.4 |
| `src/pages/attendance/AttendancePage.tsx` | EDIT | 2.3, 2.4 |
| `src/pages/leave/MyLeavesPage.tsx` | EDIT | 2.3, 2.4 |
| `src/pages/leave/LeaveRequestPage.tsx` | EDIT | 2.3 |
| `src/pages/schedule/MySchedulePage.tsx` | EDIT | 2.3, 2.4 |
| `src/components/TankActionSheet.tsx` | CREATE | 3.1 |
| `src/components/index.ts` | EDIT | 3.1 |
| `src/components/cards/TankCard.tsx` | EDIT | 3.2 |
| `src/pages/record/RecordHubPage.tsx` | DELETE/DEPRECATE | 3.3 |
| `src/pages/hr/HrHubPage.tsx` | DELETE/DEPRECATE | 3.3 |

All paths relative to `web/apps/aquamobil/`.

---

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Konsta Page removal breaks safe-area padding | Medium | Medium | Test on iPhone SE, iPhone 15, Galaxy A series. Ensure `pb-safe` and `pt-safe-top` utilities still apply. |
| Dark mode toggle causes flash on slow devices | Low | Low | Inline script in `<head>` prevents flash. Test on 3G-throttled Chrome DevTools. |
| HR items hidden in Operations tab confuses HR staff | Medium | Low | "Staff" group has distinct emerald/indigo/purple gradients. Monitor user feedback post-deploy. Can revert to dedicated HR tab if needed. |
| Redirect routes break deep links from push notifications | Medium | High | Push notification payloads use full paths (`/tasks/123`, `/feeding/record`). These paths are unchanged. Only `/record`, `/hr`, `/more` are redirected -- verify no notification payloads use these root paths. |
| TankActionSheet adds a tap to common operations | Medium | Medium | The context menu adds one tap vs. the current inline buttons. However, the inline buttons had a 15px icon which is below WCAG minimums. The sheet provides larger targets. Monitor task completion time in field trials. |

---

## 11. Quality Criteria

Before marking this redesign as complete, verify:

- [ ] All 4 tabs render correctly on 320px, 375px, and 428px viewport widths
- [ ] Dark mode toggle persists across app restarts
- [ ] Dark mode respects OS preference when set to "system"
- [ ] No flash of wrong theme on app load (test with DevTools "disable cache" + hard refresh)
- [ ] All redirect routes (`/record`, `/hr`, `/more`) land on correct new pages
- [ ] Push notifications still navigate to correct pages
- [ ] TankActionSheet dismisses on backdrop tap and back gesture
- [ ] Skeleton loaders appear on all data-fetching pages
- [ ] No Konsta layout components remain in SyncStatusPage
- [ ] AccountPage shows correct user name, email, role, and avatar initials
- [ ] Offline banner still appears correctly in MobileLayout
- [ ] Badge counts on tab icons are accurate (pending sync + unread on Account, task count on Tasks)
- [ ] Feature-gated operations hide correctly when permissions are denied
- [ ] Build succeeds with zero TypeScript errors
- [ ] All existing tests pass (especially `offline-queue.spec.ts` and `useMobilePermissions.spec.ts`)

---

## 12. Enterprise Review Findings (4 Reviewers, 2026-03-28)

### Security Review: 7/7 PASS
- Zero new attack surface. Pure UI restructuring reusing existing secure abstractions.
- CSP inline script nonce: verify nginx `Content-Security-Policy` allows the dark mode inline script.

### UX/Mobile Review: REVISE — 5 Required Fixes

1. **Operations tab nested route active-state**: Routes like `/feeding/record` don't start with `/operations`. Add `childPaths` array to tab definition matching all sub-route prefixes.
2. **Stale-data timestamps**: Home dashboard must show "Last refreshed: X min ago" for cached data. Offline form submissions need explicit "Saved locally" confirmation toast.
3. **Accessibility section needed**: ARIA landmarks (`role="tablist"`, `aria-selected`), focus trap for bottom sheet, contrast audit for 10px text on gradients, `prefers-reduced-motion` support.
4. **Pull-to-refresh**: Add to Phase 2 scope. Platform-standard interaction every competitor implements.
5. **useMyTasks hook**: Cannot be called conditionally in MobileLayout. Extract to `<TaskBadgeProvider>` child component or use `enabled` parameter.

### Technical Architecture Review: REVISE — 3 Required Fixes

1. **Cache clear = data loss**: "Clear Cache" button must NOT call `clearAllOperations()`. Separate into "Clear Cache" (safe) and "Clear Offline Queue" (destructive with confirmation showing pending count).
2. **Konsta Page dark mode**: Move compatibility check from Phase 3 to Phase 1. Replace `<Page>` with `<div>` if needed — this blocks the entire dark mode feature.
3. **Testing section**: Add automated tests for useDarkMode, OperationsHubPage permissions, redirect routes. 8+ test cases minimum.

### Aquaculture Domain Review: REVISE — 5 Critical Additions

1. **Emergency Rapid Entry Mode**: Persistent red "Emergency" button. Batch mortality recording (multi-tank, single form). Emergency alert creation (push to all managers). The TankActionSheet adds a tap to mortality recording — keep inline for this critical action.
2. **Regulatory/Compliance Features**: Add "Treatments" operation card. Audit log viewer (read-only, filterable). Operator stamp on every record. Protect unsynced regulatory records from cache clear.
3. **Shift-Aware Workflow**: Reorder Daily Operations to: Clock In → Mortality → Water Quality → Feeding (matches actual shift sequence). Add shift handoff card to dashboard.
4. **Multi-Site Support**: Site selector in header. Filter tanks/tasks/notifications by site. Tag offline operations with site context.
5. **Environmental UX**: Increase 3-dot menu trigger to 48x48px. Consider outdoor high-contrast theme. Document that sunlight readability relies on OS brightness.

### Revised Phase Structure

```
Phase 1: Foundation (Week 1) — UPDATED
  - Task 1.0: Konsta <Page> dark mode compatibility (MOVED from Phase 3)
  - Task 1.1: useDarkMode hook + index.html flash prevention
  - Task 1.2: AccountPage (separate Clear Cache from Clear Queue)
  - Task 1.3: OperationsHubPage (shift-aware ordering)
  - Task 1.4: Tab navigation (4 tabs + childPaths active-state fix)

Phase 2: Consistency + UX (Week 2) — UPDATED
  - Task 2.1: Home dashboard (stale-data timestamp + shift handoff card)
  - Task 2.2: SyncStatusPage Tailwind rewrite
  - Task 2.3: Back buttons + gradient header standardization
  - Task 2.4: Skeleton loaders + pull-to-refresh
  - Task 2.5: Accessibility pass (ARIA, focus trap, contrast audit)

Phase 3: Polish + Domain (Week 3) — UPDATED
  - Task 3.1: TankActionSheet (keep mortality inline, 3-dot for others)
  - Task 3.2: TankCard refactor
  - Task 3.3: Clean up old pages
  - Task 3.4: Emergency rapid entry mode (batch mortality, alert creation)
  - Task 3.5: Automated tests (8+ test cases)

Phase 4: Backlog (Future)
  - Treatments/compliance operation card
  - Audit log viewer
  - Multi-site selector
  - Seasonal operation prioritization
  - Global search
  - Swipe-to-action
  - i18n support
  - Shift-contextual suggestions
```
