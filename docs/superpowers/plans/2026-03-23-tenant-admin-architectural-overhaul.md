# Tenant-Admin Architectural Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task MUST conclude with a commit. Each agent MUST receive the full context described in the prompt section — no shortcuts.

**Goal:** Transform the tenant-admin module from a 2.5/10 health score to production-ready enterprise quality by fixing all 63 verified findings across 6 CRITICAL, 16 HIGH, 24 MEDIUM, and 17 LOW issues — with architectural solutions (no patches), full E2E test coverage, and a commit after every task.

**Architecture:** Consolidate the bifurcated API layer into a single GraphQL-first service with typed hooks. Complete the TanStack Query migration. Decompose god components into focused units. Fix all backend contract mismatches. Add defence-in-depth security layers.

**Tech Stack:** React 18, TanStack Query v5, TypeScript strict, Vite Module Federation, Playwright (E2E), GraphQL

**Constraints (from user):**
- Mimari çözüm — yama kesinlikle yasak
- Agent prompt'ları üst seviyede, her detay dikkate alınmalı
- Her aşamadan sonra commit
- Yapılanlar E2E testlerine yazılmalı
- Yolda başka sorunlar görülürse enterprise-scale agent'lar oluşturulmalı

---

## File Structure Overview

### New Files to Create
```
web/modules/tenant-admin/src/
  lib/
    query-keys.ts              # Centralized query key factory (replaces fragmented keys)
    api.ts                     # Single API layer (replaces tenantApi.ts + tenant-api.service.ts)
    types.ts                   # Single source of truth for all types (replaces 4 User interfaces)
    constants.ts               # Shared constants (ROLE_COLORS, MODULE_CODES, etc.)
  components/
    ui/
      StatusBadge.tsx          # Extracted shared UI primitive
      RoleBadge.tsx            # Extracted shared UI primitive
      UserAvatar.tsx           # Extracted shared UI primitive
      ExportButton.tsx         # Reusable export with real functionality
      ImportButton.tsx         # Reusable import with real functionality
    users/
      UserListSection.tsx      # Decomposed from god TenantUsers
      UserFilters.tsx          # Search + status + role filters
      BulkActions.tsx          # Bulk select/deactivate with proper error handling
    settings/
      GeneralSettings.tsx      # Decomposed from god TenantSettings
      NotificationSettings.tsx
      SecuritySettings.tsx     # With "coming soon" banner
      LocalizationSettings.tsx # With "coming soon" banner
      AppearanceSettings.tsx   # With "coming soon" banner
      MobileSettings.tsx
    modules/
      ModuleCard.tsx           # Decomposed from god TenantModules
      ModuleManagerAssign.tsx

e2e/tests/modules/tenant-admin/
  tenant-settings.spec.ts      # E2E: settings CRUD
  tenant-users.spec.ts         # E2E: user management
  tenant-communication.spec.ts # E2E: messages/support/announcements
  tenant-modules.spec.ts       # E2E: module management
  tenant-security.spec.ts      # E2E: schema isolation, IDOR protection
  tenant-billing.spec.ts       # E2E: billing page data integrity
```

### Files to Modify (key ones)
```
web/modules/tenant-admin/src/
  Module.tsx                           # Lazy loading, route guards
  pages/TenantSettings.tsx             # Decompose → section components
  pages/TenantUsers.tsx                # Decompose → section components, TanStack Query
  pages/TenantModules.tsx              # Decompose → section components, TanStack Query
  pages/TenantDashboard.tsx            # Fix stats, memoization
  pages/TenantMessagesPage.tsx         # GraphQL migration (from REST)
  pages/TenantSupportPage.tsx          # GraphQL migration (from REST)
  pages/TenantAnnouncementsPage.tsx    # GraphQL migration (from REST)
  pages/TenantDatabase.tsx             # Schema whitelist validation
  pages/EdgeDeviceDetailPage.tsx       # Device polling guard
  hooks/useTenantRoles.ts              # Fix optimistic update
  hooks/useTenantData.ts               # Unified query key factory
  components/users/AddEditUserModal.tsx # Role edit mode fix
  components/devices/InstallerKeyModal.tsx # Safety limits
  graphql/tenant-queries.ts            # Fix updateTenantSettings mutation
  graphql/billing-queries.ts           # Fix field alignment
  vite.config.ts                       # Federation fixes

web/shared-ui/src/components/Layout/Sidebar.tsx  # startsWith matching
web/modules/farm-module/src/pages/MapViewPage.tsx # Coordinate fallback

docker-compose.droplet.yml             # TRUST_PROXY env var
```

---

## PHASE 1: CRITICAL FIXES (P0)
*Goal: Make the 3 broken pages work, fix data corruption, normalize API contracts*

### Task 1: Fix updateTenantSettings → updateTenant mutation (CRIT-01)

**Files:**
- Modify: `web/modules/tenant-admin/src/graphql/tenant-queries.ts`
- Modify: `web/modules/tenant-admin/src/pages/TenantSettings.tsx`
- Create: `e2e/tests/modules/tenant-admin/tenant-settings.spec.ts`

**Agent Prompt:**
```
ARCHITECTURAL FIX — not a patch. Read ALL files before making changes.

CONTEXT: The frontend calls `updateTenantSettings(input: UpdateTenantInput!)` mutation but this was
removed from the backend and consolidated into `updateTenant(id: ID!, input: UpdateTenantInput!)`.
The backend resolver is at apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts.

STEP 1: Read the backend tenant resolver to find the exact mutation signature for `updateTenant`.
Read: apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts
Find the updateTenant mutation — note the exact input type, return type, and required parameters.

STEP 2: Read the current frontend mutation definition.
Read: web/modules/tenant-admin/src/graphql/tenant-queries.ts
Find UPDATE_TENANT_SETTINGS_MUTATION.

STEP 3: Fix the mutation to match backend.
Edit web/modules/tenant-admin/src/graphql/tenant-queries.ts:
- Rename UPDATE_TENANT_SETTINGS_MUTATION to UPDATE_TENANT_MUTATION
- Change the mutation body to call `updateTenant(id: $id, input: $input)` with the correct signature
- Update the return fields to match what the backend resolver actually returns

STEP 4: Read TenantSettings.tsx to find where the mutation is called.
Read: web/modules/tenant-admin/src/pages/TenantSettings.tsx
Find the handleSave/handleSaveSettings function.

STEP 5: Fix TenantSettings.tsx to use the new mutation.
- The mutation now requires `id` parameter — get tenant ID from the myTenant query response
- Update the graphqlRequest call to pass both `id` and `input` variables
- Ensure the response field name matches (`updateTenant` not `updateTenantSettings`)

STEP 6: Write E2E test.
Create: e2e/tests/modules/tenant-admin/tenant-settings.spec.ts
```typescript
import { test, expect } from '@playwright/test';

test.describe('Tenant Settings', () => {
  test.beforeEach(async ({ page }) => {
    // Login as tenant admin
    await page.goto('/');
    // ... login flow with okan@oceanfarm.eu
  });

  test('should save general settings successfully', async ({ page }) => {
    await page.goto('/tenant/settings');
    await page.waitForSelector('[data-testid="settings-general"]');

    // Modify a field
    const nameInput = page.locator('input[name="name"]');
    await nameInput.clear();
    await nameInput.fill('Test Tenant Updated');

    // Save
    await page.click('button:has-text("Save")');

    // Verify success toast/message
    await expect(page.locator('[data-testid="success-message"]')).toBeVisible({ timeout: 5000 });

    // Reload and verify persistence
    await page.reload();
    await expect(nameInput).toHaveValue('Test Tenant Updated');
  });
});
```

STEP 7: TypeScript check — run: npx tsc -p web/modules/tenant-admin/tsconfig.json --noEmit
STEP 8: Commit with descriptive message.
```

---

### Task 2: Migrate Messages/Support/Announcements from REST to GraphQL (CRIT-02)

**Files:**
- Modify: `web/modules/tenant-admin/src/services/tenantApi.ts` (remove REST endpoints)
- Create: `web/modules/tenant-admin/src/graphql/communication-queries.ts`
- Modify: `web/modules/tenant-admin/src/pages/TenantMessagesPage.tsx`
- Modify: `web/modules/tenant-admin/src/pages/TenantSupportPage.tsx`
- Modify: `web/modules/tenant-admin/src/pages/TenantAnnouncementsPage.tsx`
- Create: `e2e/tests/modules/tenant-admin/tenant-communication.spec.ts`

**Agent Prompt:**
```
ARCHITECTURAL FIX — Migrate 3 pages from non-existent REST endpoints to GraphQL.

CONTEXT: tenantApi.ts defines 14 REST endpoints (/support/messages/*, /support/tickets/*,
/support/announcements/*) but NO REST controllers exist in the backend. The auth-service only
has GraphQL resolvers: MessagingResolver, SupportResolver. All 3 pages return 404 at runtime.

STEP 1: Read the backend GraphQL resolvers to understand the actual API.
Read: apps/auth-service/src/modules/messaging/resolvers/messaging.resolver.ts
Read: apps/auth-service/src/modules/support/resolvers/support.resolver.ts
Note every query/mutation name, input type, and return type.
Also check if announcements have a resolver — search for AnnouncementResolver.

STEP 2: Create communication-queries.ts with GraphQL operations matching the backend.
Create: web/modules/tenant-admin/src/graphql/communication-queries.ts

For each backend resolver method, create the corresponding GraphQL query/mutation string.
Example pattern:
```graphql
export const MESSAGE_THREADS_QUERY = `
  query MessageThreads($status: String) {
    messageThreads(status: $status) {
      id subject status lastMessageAt
      messages { id content senderType createdAt }
    }
  }
`;
```

STEP 3: Read each page component to understand current data flow.
Read: web/modules/tenant-admin/src/pages/TenantMessagesPage.tsx
Read: web/modules/tenant-admin/src/pages/TenantSupportPage.tsx
Read: web/modules/tenant-admin/src/pages/TenantAnnouncementsPage.tsx

STEP 4: Rewrite each page to use GraphQL via graphqlClient instead of REST fetch.
For each page:
- Replace REST fetch calls with graphqlRequest using the new query strings
- Use TanStack Query (useQuery/useMutation) — do NOT use raw useState/useEffect/fetch
- Maintain the same UI/UX but with working data flow
- Add proper error handling with user-visible error messages
- Add loading states

STEP 5: Remove the dead REST functions from tenantApi.ts.
Remove: getThreads, getThreadMessages, sendMessage, getTickets, getTicket, createTicket,
getComments, addComment, getAnnouncements, markAnnouncementRead, submitRating, etc.
Keep only functions that are actually used and working.

STEP 6: Write E2E tests for all 3 pages.
Create: e2e/tests/modules/tenant-admin/tenant-communication.spec.ts

STEP 7: TypeScript check + commit.
```

---

### Task 3: Fix optimistic role create + Plan enum normalization (CRIT-03 + CRIT-06)

**Files:**
- Modify: `web/modules/tenant-admin/src/hooks/useTenantRoles.ts`
- Modify: `web/modules/tenant-admin/src/services/tenant-api.service.ts` (Plan enum)
- Modify: `web/modules/tenant-admin/src/graphql/tenant-queries.ts` (Plan enum usage)

**Agent Prompt:**
```
TWO ARCHITECTURAL FIXES in one task.

FIX 1: Optimistic Role Create Data Corruption (CRIT-03)

Read: web/modules/tenant-admin/src/hooks/useTenantRoles.ts

The bug is in the createRole mutation's onSuccess callback. It uses:
  role.id.startsWith('temp-')
This matches ALL temp entries, not just the one being created. If two roles are created
in quick succession, the second onSuccess replaces ALL remaining temp entries with
the same server response.

FIX: Track the specific optimistic entry ID. In onMutate, store the generated temp ID.
In onSuccess, match ONLY that specific temp ID:

```typescript
onMutate: async (newRole) => {
  const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // ... cancel queries, snapshot ...
  const optimisticRole = { ...newRole, id: tempId, /* ... */ };
  queryClient.setQueryData(key, (old) => [...(old || []), optimisticRole]);
  return { previousRoles, tempId }; // Pass tempId in context
},
onSuccess: (serverRole, _variables, context) => {
  // Replace ONLY the specific temp entry
  queryClient.setQueryData(key, (old) =>
    (old || []).map(role => role.id === context?.tempId ? serverRole : role)
  );
},
```

FIX 2: Plan Enum Case Normalization (CRIT-06)

Read: web/modules/tenant-admin/src/services/tenant-api.service.ts
Find the Plan type definition — it uses UPPERCASE ('TRIAL', 'STARTER', etc.)

Read: apps/auth-service/src/modules/tenant/entities/tenant.entity.ts
Find the TenantPlan enum — it uses lowercase ('trial', 'starter', etc.)

FIX: Change the frontend Plan type to match backend:
```typescript
type Plan = 'trial' | 'starter' | 'professional' | 'enterprise';
```
Then find ALL comparisons like `tenant.plan === 'TRIAL'` and change to lowercase.
Search across ALL tenant-admin files for Plan enum usage.

TypeScript check + commit.
```

---

### Task 4: Consolidate API layer — single source of truth (CRIT-04)

**Files:**
- Create: `web/modules/tenant-admin/src/lib/api.ts`
- Create: `web/modules/tenant-admin/src/lib/types.ts`
- Create: `web/modules/tenant-admin/src/lib/query-keys.ts`
- Modify: `web/modules/tenant-admin/src/services/index.ts`
- Delete content from: `web/modules/tenant-admin/src/services/tenantApi.ts` (re-export from lib/api)
- Delete content from: `web/modules/tenant-admin/src/services/tenant-api.service.ts` (re-export from lib/api)

**Agent Prompt:**
```
ARCHITECTURAL REFACTOR — Consolidate bifurcated API layer.

CONTEXT: Two parallel service files exist (tenantApi.ts and tenant-api.service.ts) with
overlapping exports. Additionally, graphqlRequest is used directly in 13 files, bypassing
typed service functions. 4 independent User interfaces exist across 4 files.

STEP 1: Read ALL service and type files to understand current state.
Read: web/modules/tenant-admin/src/services/tenantApi.ts
Read: web/modules/tenant-admin/src/services/tenant-api.service.ts
Read: web/modules/tenant-admin/src/services/api-client.ts
Read: web/modules/tenant-admin/src/services/index.ts

STEP 2: Read ALL graphql query files — these define the actual API contract.
Read all files in: web/modules/tenant-admin/src/graphql/

STEP 3: Grep for all User/Tenant type definitions across the module.
Search for: interface User, interface TenantUser, interface ApiUser, type User
Note every file and line number.

STEP 4: Create lib/types.ts — SINGLE source of truth for all types.
Create: web/modules/tenant-admin/src/lib/types.ts
- Define ONE User interface that covers all use cases
- Define ONE Tenant interface
- Define ONE Module interface
- Define Plan, Role, Permission types
- Export everything from this single file

STEP 5: Create lib/query-keys.ts — centralized query key factory.
Create: web/modules/tenant-admin/src/lib/query-keys.ts
```typescript
export const tenantKeys = {
  all: ['tenant'] as const,
  detail: () => [...tenantKeys.all, 'detail'] as const,
  stats: () => [...tenantKeys.all, 'stats'] as const,
  users: {
    all: [...tenantKeys.all, 'users'] as const,
    list: (filters?: Record<string, unknown>) => [...tenantKeys.users.all, 'list', filters] as const,
    detail: (id: string) => [...tenantKeys.users.all, 'detail', id] as const,
  },
  modules: {
    all: [...tenantKeys.all, 'modules'] as const,
    list: () => [...tenantKeys.modules.all, 'list'] as const,
  },
  roles: {
    all: [...tenantKeys.all, 'roles'] as const,
    list: () => [...tenantKeys.roles.all, 'list'] as const,
  },
  billing: {
    all: [...tenantKeys.all, 'billing'] as const,
  },
  database: {
    all: [...tenantKeys.all, 'database'] as const,
    schema: (table: string) => [...tenantKeys.database.all, 'schema', table] as const,
  },
  devices: {
    all: [...tenantKeys.all, 'devices'] as const,
    detail: (id: string) => [...tenantKeys.devices.all, id] as const,
  },
  communication: {
    threads: () => [...tenantKeys.all, 'threads'] as const,
    tickets: () => [...tenantKeys.all, 'tickets'] as const,
    announcements: () => [...tenantKeys.all, 'announcements'] as const,
  },
} as const;
```

STEP 6: Create lib/api.ts — single API module wrapping all GraphQL operations.
Create: web/modules/tenant-admin/src/lib/api.ts
- Import graphqlClient from @aquaculture/shared-ui
- Import ALL query strings from ../graphql/*
- Export typed functions for every operation
- NO raw graphqlRequest usage outside this file
- Every function returns properly typed results

STEP 7: Update services/index.ts to re-export from lib/.
Make the old service files re-export from lib/api.ts for backward compatibility.

STEP 8: Update ALL page files that use raw graphqlRequest to import from lib/api instead.
Search for: graphqlRequest, graphqlClient.request across all tenant-admin source files.
Replace each raw call with the typed function from lib/api.

STEP 9: TypeScript check + commit.
```

---

### Task 5: Complete TanStack Query migration — 6 pages (CRIT-05)

**Files:**
- Modify: `web/modules/tenant-admin/src/pages/TenantUsers.tsx`
- Modify: `web/modules/tenant-admin/src/pages/EdgeDevicesPage.tsx`
- Modify: `web/modules/tenant-admin/src/pages/TenantMessagesPage.tsx` (if not done in Task 2)
- Modify: `web/modules/tenant-admin/src/pages/TenantSettings.tsx`
- Modify: `web/modules/tenant-admin/src/pages/TenantModules.tsx`
- Modify: `web/modules/tenant-admin/src/pages/TenantAnnouncementsPage.tsx` (if not done in Task 2)

**Agent Prompt:**
```
ARCHITECTURAL MIGRATION — Complete TanStack Query adoption across all pages.

CONTEXT: TanStack Query hooks exist (useTenantData, useTenantRoles) but 6+ pages bypass them
with raw useState/useEffect/fetch. This causes: no cache sharing, no request dedup, no background
refetch, manual loading/error state management, race conditions.

PREREQUISITES: lib/api.ts and lib/query-keys.ts must exist from Task 4.

For EACH page that uses raw useState/useEffect/fetch pattern:

STEP 1: Read the page file completely.
STEP 2: Identify all data-fetching patterns:
  - useState for loading/error/data
  - useEffect with fetch calls
  - Manual graphqlRequest calls
  - Any loadData/refreshData functions

STEP 3: Replace with TanStack Query hooks:
  - useQuery for data fetching (with query keys from lib/query-keys.ts)
  - useMutation for mutations (with onSuccess invalidation)
  - Remove manual loading/error useState
  - Remove useEffect fetch triggers
  - Use queryClient.invalidateQueries for cache refresh after mutations

PATTERN TO FOLLOW:
```typescript
// BEFORE (anti-pattern):
const [users, setUsers] = useState([]);
const [loading, setLoading] = useState(true);
const [error, setError] = useState(null);
useEffect(() => {
  loadUsers();
}, []);
const loadUsers = async () => {
  setLoading(true);
  try {
    const data = await graphqlRequest(QUERY);
    setUsers(data);
  } catch (e) { setError(e.message); }
  finally { setLoading(false); }
};

// AFTER (correct):
const { data: users = [], isLoading, error } = useQuery({
  queryKey: tenantKeys.users.list(filters),
  queryFn: () => api.getUsers(filters),
});
```

STEP 4: For mutations, use proper invalidation:
```typescript
const createUser = useMutation({
  mutationFn: api.createUser,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: tenantKeys.users.all });
    toast.success('User created');
    setModalOpen(false);
  },
  onError: (err) => toast.error(err.message),
});
```

STEP 5: Verify no raw graphqlRequest calls remain in any page file.
Run: grep -rn "graphqlRequest\|useState.*loading\|useState.*error" web/modules/tenant-admin/src/pages/

STEP 6: TypeScript check + commit.
```

---

### Task 6: Fix billing query fields + status filter enum (HIGH-11, HIGH-12)

**Files:**
- Modify: `web/modules/tenant-admin/src/graphql/billing-queries.ts`
- Modify: `web/modules/tenant-admin/src/pages/TenantUsers.tsx` (status filter)
- Modify: `web/modules/tenant-admin/src/hooks/useTenantBilling.ts`

**Agent Prompt:**
```
TWO CONTRACT FIXES.

FIX 1: Billing query field alignment (HIGH-12)
Read: apps/billing-service/src/billing/billing.resolver.ts
Read: apps/billing-service/src/billing/entities/ — find PlanLimits entity
Read: web/modules/tenant-admin/src/graphql/billing-queries.ts

The frontend TENANT_BILLING_QUERY selects fields that don't exist in backend:
maxStorage, currentFarms, currentSensors, currentUsers, currentStorage.

Fix: Remove non-existent fields from the query. Only select fields the backend actually returns.
Cross-reference every field in the query with the backend resolver/entity.

FIX 2: Status filter enum mismatch (HIGH-11)
Read: web/modules/tenant-admin/src/pages/TenantUsers.tsx
Find the status filter — it sends 'active', 'inactive', 'pending' (lowercase strings).

Read: apps/auth-service/src/modules/authentication/entities/user.entity.ts
The User entity has `isActive: boolean` — NOT a status string enum.

Read: apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts
Find the tenantUsers query — what filter parameters does it accept?

Fix the frontend filter to match what the backend actually accepts.
If backend accepts boolean isActive, change the filter accordingly.

TypeScript check + commit.
```

---

## PHASE 2: HIGH PRIORITY FIXES (P1)
*Goal: Security hardening, federation stability, code quality*

### Task 7: Schema whitelist + IDOR protection + autoApprove limits (HIGH-01, HIGH-02, HIGH-03)

**Files:**
- Modify: `web/modules/tenant-admin/src/pages/TenantDatabase.tsx`
- Modify: `web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx`
- Create: `e2e/tests/modules/tenant-admin/tenant-security.spec.ts`

**Agent Prompt:**
```
SECURITY HARDENING — Defence-in-depth, not patches.

FIX 1: Schema whitelist in TenantDatabase (HIGH-01)
Read: web/modules/tenant-admin/src/pages/TenantDatabase.tsx

The page allows browsing DB tables but doesn't validate the schema name.
A TENANT_ADMIN could use DevTools to query other tenants' schemas.

Add client-side defence-in-depth:
- Extract the tenant's own schema name from the initial TENANT_DATABASE_QUERY response
- Only allow queries where schemaName matches the tenant's own schema
- Add a validation check before every TABLE_SCHEMA_QUERY and TABLE_DATA_QUERY call
- Log a security warning if a non-matching schema is attempted

FIX 2: autoApprove provisioning key safety limits (HIGH-03)
Read: web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx

Currently allows creating unlimited, non-expiring, auto-approve provisioning keys.

Add mandatory safety limits:
- If autoApprove is true, REQUIRE maxDevices (min 1, max 100) and expiresInDays (min 1, max 365)
- Add a confirmation dialog for autoApprove keys: "This key will automatically approve devices. Are you sure?"
- Disable the Create button until safety limits are set

FIX 3: Write security E2E tests.
Create: e2e/tests/modules/tenant-admin/tenant-security.spec.ts
Test that schema queries are restricted to own tenant schema.
Test that autoApprove keys require safety limits.

TypeScript check + commit.
```

---

### Task 8: Federation config + inline GraphQL cleanup (HIGH-09, HIGH-10, HIGH-16)

**Files:**
- Modify: `web/modules/tenant-admin/vite.config.ts`
- Modify: `web/modules/tenant-admin/src/pages/TenantUsers.tsx` (remove inline GraphQL)
- Modify: `web/modules/tenant-admin/package.json`

**Agent Prompt:**
```
FEDERATION + CODE QUALITY fixes.

FIX 1: Add requiredVersion for @aquaculture/shared-ui (HIGH-09)
Read: web/modules/tenant-admin/vite.config.ts
Read: web/shell/vite.config.ts (for reference — find shared-ui requiredVersion)

Add requiredVersion to shared-ui in the federation shared config.
Also add lucide-react to the shared config to prevent duplicate bundling.
Remove zustand from shared config (it's unused).

FIX 2: Remove inline GraphQL from TenantUsers (HIGH-16)
Read: web/modules/tenant-admin/src/pages/TenantUsers.tsx
Read: web/modules/tenant-admin/src/graphql/user-queries.ts

Find ALL inline GraphQL query/mutation strings in TenantUsers.tsx.
Replace them with imports from graphql/user-queries.ts.
If the centralized version is missing fields the inline version has, add them to the centralized file.

FIX 3: Update lucide-react version (HIGH-10)
Update package.json: lucide-react from ^0.303.0 to latest stable.

TypeScript check + commit.
```

---

### Task 9: God component decomposition — TenantUsers (HIGH-14)

**Files:**
- Create: `web/modules/tenant-admin/src/components/users/UserListSection.tsx`
- Create: `web/modules/tenant-admin/src/components/users/UserFilters.tsx`
- Create: `web/modules/tenant-admin/src/components/users/BulkActions.tsx`
- Create: `web/modules/tenant-admin/src/components/ui/StatusBadge.tsx`
- Create: `web/modules/tenant-admin/src/components/ui/RoleBadge.tsx`
- Create: `web/modules/tenant-admin/src/components/ui/UserAvatar.tsx`
- Modify: `web/modules/tenant-admin/src/pages/TenantUsers.tsx` (reduce to <200 lines)

**Agent Prompt:**
```
ARCHITECTURAL DECOMPOSITION — Break god component into focused units.

CONTEXT: TenantUsers.tsx is ~650 lines mixing: data fetching, mutation handling, modal state,
filters, bulk actions, user list rendering, inline GraphQL, inline UI components (StatusBadge,
RoleBadge, UserAvatar are defined 3x across the codebase).

Read: web/modules/tenant-admin/src/pages/TenantUsers.tsx (entire file)

STEP 1: Extract shared UI primitives.
Create StatusBadge.tsx, RoleBadge.tsx, UserAvatar.tsx in components/ui/.
These should be React.memo wrapped, accept typed props, and be reusable across all pages.
Search for ALL instances of StatusBadge/RoleBadge/UserAvatar across the module and replace.

STEP 2: Extract UserFilters component.
Create UserFilters.tsx — handles search input, status dropdown, role dropdown.
Props: onSearchChange, onStatusChange, onRoleChange, currentFilters.

STEP 3: Extract BulkActions component.
Create BulkActions.tsx — handles select all, bulk deactivate with proper error handling.
FIX the bulk deactivate to use Promise.allSettled instead of Promise.all (HIGH-05).
Show per-item results (success/failure) after bulk operation.

STEP 4: Extract UserListSection component.
Create UserListSection.tsx — the table/list rendering with pagination.
FIX the pagination next button condition (MED-07).

STEP 5: Slim down TenantUsers.tsx to be a pure orchestrator.
It should ONLY:
- Compose the above components
- Manage modal open/close state
- Wire up TanStack Query hooks (from Task 5)
Target: <200 lines.

STEP 6: TypeScript check + commit.
```

---

### Task 10: God component decomposition — TenantSettings + TenantModules (HIGH-14 cont.)

**Files:**
- Create: `web/modules/tenant-admin/src/components/settings/GeneralSettings.tsx`
- Create: `web/modules/tenant-admin/src/components/settings/NotificationSettings.tsx`
- Create: `web/modules/tenant-admin/src/components/settings/SecuritySettings.tsx`
- Create: `web/modules/tenant-admin/src/components/settings/LocalizationSettings.tsx`
- Create: `web/modules/tenant-admin/src/components/settings/MobileSettings.tsx`
- Create: `web/modules/tenant-admin/src/components/modules/ModuleCard.tsx`
- Modify: `web/modules/tenant-admin/src/pages/TenantSettings.tsx`
- Modify: `web/modules/tenant-admin/src/pages/TenantModules.tsx`

**Agent Prompt:**
```
ARCHITECTURAL DECOMPOSITION — TenantSettings (~600 lines) and TenantModules (~780 lines).

For TenantSettings:
- Extract each settings section into its own component
- GeneralSettings: name, description, logo, contact info + Save button
- NotificationSettings: notification preferences with TanStack Query
- SecuritySettings: render with "Coming Soon" banner (MED-01) — NO interactive controls that do nothing
- LocalizationSettings: render with "Coming Soon" banner — NO interactive controls that do nothing
- MobileSettings: mobile user feature toggles
- FIX notification overwrite bug (HIGH-08): use optimistic updates, don't re-fetch on section switch
- Target TenantSettings.tsx: <150 lines (just section tabs + composition)

For TenantModules:
- Extract ModuleCard component
- FIX React key flicker (MED-08): use stable keys (module.code, not UUID)
- FIX UUID fetch error swallowing (MED-17): show error state when UUID fetch fails
- Move to TanStack Query (remove raw graphqlRequest)
- Target TenantModules.tsx: <200 lines

TypeScript check + commit.
```

---

### Task 11: Remaining HIGH fixes (HIGH-04, HIGH-06, HIGH-07, HIGH-13, HIGH-15)

**Files:**
- Modify: `web/modules/tenant-admin/src/pages/TenantUsers.tsx` (handleSaveUser fix)
- Modify: `web/modules/tenant-admin/src/hooks/useDevicePolling.ts` (empty ID guard)
- Modify: `web/modules/tenant-admin/src/components/users/AddEditUserModal.tsx` (roles edit + roleId validation)
- Modify: `web/modules/tenant-admin/src/pages/TenantDashboard.tsx` (type consolidation)

**Agent Prompt:**
```
BATCH HIGH FIXES — all architectural, not patches.

HIGH-04: handleSaveUser modal race condition
Read: web/modules/tenant-admin/src/pages/TenantUsers.tsx
The modal closes before loadUsers() completes. If loadUsers fails, error is set on closed modal.
FIX: Use useMutation with onSuccess/onError. Close modal only after ALL async work completes.

HIGH-06: Device polling with empty deviceId
Read: web/modules/tenant-admin/src/hooks/useDevicePolling.ts
Read: web/modules/tenant-admin/src/pages/EdgeDeviceDetailPage.tsx
FIX: Add enabled: !!deviceId to the useQuery config. Add refetchInterval: deviceId ? intervalMs : false.

HIGH-07: AddEditUserModal role edit mode lock
Read: web/modules/tenant-admin/src/components/users/AddEditUserModal.tsx
In edit mode, the submit button is disabled when roles.length === 0, even if the user already has a role.
FIX: In edit mode, allow submission without role change. Only require role selection for new users.

HIGH-13: roleId validation
The form allows submission without roleId for new users. Add client-side validation.

HIGH-15: Type consolidation
After lib/types.ts exists (from Task 4), update TenantDashboard.tsx to import from lib/types
instead of defining its own User interface.
Search for ALL remaining local type definitions across the module and replace with lib/types imports.

TypeScript check + commit.
```

---

## PHASE 3: MEDIUM FIXES (P2)
*Goal: Performance, UX polish, code quality*

### Task 12: Performance — memoization + lazy loading + polling (MED-02 through MED-24)

**Files:**
- Modify: `web/modules/tenant-admin/src/Module.tsx` (lazy loading)
- Modify: `web/modules/tenant-admin/src/pages/TenantDatabase.tsx` (filteredTables memo)
- Modify: `web/modules/tenant-admin/src/pages/TenantDashboard.tsx` (stats memo, "Bu Ay" fix)
- Modify: `web/modules/tenant-admin/src/hooks/useTenantData.ts` (focused polling)

**Agent Prompt:**
```
PERFORMANCE OPTIMIZATION — systematic, not spot-fixes.

1. Lazy loading (LOW-01 → architectural):
Read Module.tsx. Replace all eager page imports with React.lazy + Suspense.

2. filteredTables memoization (MED-02):
Read TenantDatabase.tsx. Wrap filteredTables computation in useMemo.
Extract parseSize as a module-level utility function.

3. Dashboard "Bu Ay" fix (MED-06):
Read TenantDashboard.tsx. The "This Month" card shows totalUsers as growth.
FIX: Use tenantStats.monthlyGrowthPercent for the growth display.
Wrap statsData array in useMemo.

4. Focused polling (MED-24):
Read useTenantData.ts. useTenantStats polls every 60s even on other pages.
FIX: Add refetchInterval only when the component using this hook is mounted,
or use refetchOnWindowFocus: true instead of polling.

5. Memoize all UI primitives created in earlier tasks with React.memo.

TypeScript check + commit.
```

---

### Task 13: UX fixes — sidebar, map, error alerts, export/import (MED + runtime bugs)

**Files:**
- Modify: `web/shared-ui/src/components/Layout/Sidebar.tsx` (startsWith matching)
- Modify: `web/modules/farm-module/src/pages/MapViewPage.tsx` (coordinate fallback)
- Modify: `web/modules/farm-module/src/pages/setup/tabs/SpeciesTab.tsx` (error display)
- Modify: `web/modules/farm-module/src/pages/setup/SetupPage.tsx` (import button)
- Modify: `docker-compose.droplet.yml` (TRUST_PROXY)

**Agent Prompt:**
```
UX + INFRASTRUCTURE fixes.

1. Sidebar active state (U-06 / MED-16):
Read: web/shared-ui/src/components/Layout/Sidebar.tsx
The isActive check uses strict equality (===). Sub-pages don't highlight parent item.
FIX: Use startsWith matching:
  const isActive = activePath === item.path || activePath.startsWith(item.path + '/');

2. Map coordinate fallback (U-05):
Read: web/modules/farm-module/src/pages/MapViewPage.tsx
"Konum belirtilmemiş" shows even when GPS coordinates exist.
FIX: Fall back to formatted coordinates when address fields are empty:
  location: [site.address?.city, site.address?.country].filter(Boolean).join(', ')
    || (site.location?.latitude ? `${site.location.latitude.toFixed(4)}, ${site.location.longitude.toFixed(4)}` : 'Konum belirtilmemiş')

3. Species error display (V-05):
Read: web/modules/farm-module/src/pages/setup/tabs/SpeciesTab.tsx
Replace alert() with inline error message in the form.

4. Export/Import buttons (F-04, F-06):
Add proper onClick handlers or disable with "Coming Soon" tooltip if not implemented.

5. TRUST_PROXY for real client IP (S-02):
Add TRUST_PROXY: "1" to gateway-api environment in docker-compose.droplet.yml.

TypeScript check + commit.
```

---

### Task 14: Remaining MEDIUM fixes batch (MED-09 through MED-23)

**Files:**
- Modify: `web/modules/tenant-admin/vite.config.ts` (remove zustand, fix vite version)
- Modify: `web/modules/tenant-admin/package.json` (vite version, add vitest, test script)
- Modify: `web/modules/tenant-admin/src/components/ErrorBoundary.tsx` (React Router nav)
- Modify: `web/modules/tenant-admin/src/hooks/useTenantAuditLog.ts` (export full data)
- Modify: `web/modules/tenant-admin/src/pages/TenantAnnouncementsPage.tsx` (stale closure)
- Modify: `web/modules/tenant-admin/src/pages/TenantRolesPage.tsx` (remove inline RoleModal)
- Modify: `web/modules/tenant-admin/src/pages/TenantDashboard.tsx` (module code constants)
- Modify: `web/modules/tenant-admin/src/graphql/billing-queries.ts` (subscription keyword)
- Modify: `web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx` (token display)
- Modify: `web/modules/tenant-admin/src/pages/EdgeDeviceDetailPage.tsx` (events pagination)

**Agent Prompt:**
```
REMAINING MEDIUM FIXES — 13 fixes, all architectural. Read each file before editing.

STEP 1: Remove zustand from federation shared (MED-11)
Read: web/modules/tenant-admin/vite.config.ts
Remove the zustand entry from the shared config block. It has zero imports in source code.

STEP 2: Fix Vite version constraint (MED-12)
Read: web/modules/tenant-admin/package.json
The declared vite version is ^5.0.0 but 7.3.1 is installed (from monorepo root).
Update the version constraint to match what's actually used: ^7.0.0

STEP 3: Add test infrastructure (MED-13)
Read: web/modules/tenant-admin/package.json
Add vitest to devDependencies. Add "test" script: "vitest run".
Verify the 3 existing test files can be discovered:
- src/__tests__/Module.spec.tsx
- src/pages/__tests__/TenantUsers.spec.tsx
- src/hooks/__tests__/useTenantRoles.spec.ts

STEP 4: ErrorBoundary — React Router navigation (MED-16 / architecture)
Read: web/modules/tenant-admin/src/components/ErrorBoundary.tsx
Replace window.location.reload() and hardcoded window.location.href = '/tenant' with
React Router's useNavigate hook. For class components, use a wrapper:
```typescript
// Wrap the class ErrorBoundary with a functional component that provides navigate
function ErrorBoundaryWithRouter(props: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return <ErrorBoundaryClass {...props} onNavigate={() => navigate('/tenant')} onRetry={() => navigate(0)} />;
}
```

STEP 5: Audit log export full data (MED-09)
Read: web/modules/tenant-admin/src/hooks/useTenantAuditLog.ts
The export function only exports the current page (20 rows).
FIX: Before exporting, fetch ALL pages by running paginated queries until exhausted,
OR show a clear warning: "Exporting current page only (${currentPage} of ${totalPages}).
To export all data, use the API directly."

STEP 6: Stale closure in TenantAnnouncementsPage (MED-10)
Read: web/modules/tenant-admin/src/pages/TenantAnnouncementsPage.tsx
The fetchAnnouncements useCallback has an empty dependency array but references localState.
FIX: Add localState to the dependency array, or better — migrate to TanStack Query
(should already be done in Task 5, verify and fix if not).

STEP 7: Dual RoleModal — consolidate (MED-18)
Read: web/modules/tenant-admin/src/pages/TenantRolesPage.tsx (find inline RoleModal ~line 114-406)
Read: web/modules/tenant-admin/src/components/roles/RoleModal.tsx
Compare both implementations. Keep the better one (the page version has ARIA + focus trap).
Move the superior version to components/roles/RoleModal.tsx and import it in TenantRolesPage.
Delete the inline version. Consolidate ROLE_COLORS into lib/constants.ts.

STEP 8: Module code string heuristic replacement (MED-15)
Read: web/modules/tenant-admin/src/pages/TenantDashboard.tsx (find name.toLowerCase().includes)
Read: web/modules/tenant-admin/src/pages/TenantModules.tsx
Read: web/modules/tenant-admin/src/pages/TenantDatabase.tsx
Replace string heuristic module detection with a MODULE_REGISTRY constant:
```typescript
// lib/constants.ts
export const MODULE_REGISTRY: Record<string, { icon: string; color: string; route: string }> = {
  farm: { icon: 'Warehouse', color: 'green', route: '/sites' },
  hr: { icon: 'Users', color: 'blue', route: '/hr' },
  sensor: { icon: 'Activity', color: 'purple', route: '/sensor' },
  // ...
};
```
Replace all name.toLowerCase().includes('farm') checks with MODULE_REGISTRY[module.code].

STEP 9: Fix subscription keyword clash (MED-19)
Read: web/modules/tenant-admin/src/graphql/billing-queries.ts
Rename the MY_SUBSCRIPTION_QUERY's query operation name from `subscription` to `mySubscription`
to avoid GraphQL reserved keyword clash:
  query MySubscription { ... } instead of query { subscription { ... } }

STEP 10: Consolidate dual subscription query shapes (MED-20)
In billing-queries.ts, TENANT_BILLING_QUERY and MY_SUBSCRIPTION_QUERY fetch the same data
with different field shapes. Consolidate into a single query or ensure both use the same types.

STEP 11: Provisioning key token single-display (MED-21)
Read: web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx
After creating a key, show the token ONCE with a "Copy" button and a warning:
"This token will only be shown once. Copy it now."
Do NOT display full tokens in the key list (LIST_PROVISIONING_KEYS_QUERY).
Show only last 8 characters with mask: "••••••••abc12345"

STEP 12: lastBackup nullable handling (MED-22)
Read: web/modules/tenant-admin/src/services/tenant-api.service.ts
Change lastBackup type from string to string | null.
In rendering, show "No backup recorded" when null.

STEP 13: Device events pagination (MED-23)
Read: web/modules/tenant-admin/src/pages/EdgeDeviceDetailPage.tsx
Replace hardcoded limit: 50 with paginated loading.
Add a "Load More" button that fetches the next page.
Use TanStack Query's useInfiniteQuery if available.

TypeScript check + commit.
```

---

## PHASE 4: LOW FIXES + FINAL E2E (P3)
*Goal: Polish, dead code cleanup, comprehensive E2E coverage*

### Task 15: Dead code + dependency cleanup + remaining LOW fixes (LOW-01 through LOW-17)

**Files:**
- Modify: `web/modules/tenant-admin/package.json`
- Delete: `web/modules/tenant-admin/src/components/TenantAdminSidebar.tsx`
- Modify: `web/modules/tenant-admin/vite.config.ts`
- Modify: `web/modules/tenant-admin/tsconfig.json`
- Modify: `web/modules/tenant-admin/src/Module.tsx`
- Modify: `web/modules/tenant-admin/src/hooks/useDevicePolling.ts`
- Modify: `web/modules/tenant-admin/src/hooks/useFocusTrap.ts`
- Modify: `web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx`
- Create: `web/modules/tenant-admin/src/lib/error-handling.ts`

**Agent Prompt:**
```
COMPREHENSIVE CLEANUP — 17 LOW findings. Read each file before editing.

STEP 1: Remove @types/uuid from devDependencies (LOW-11)
Read: web/modules/tenant-admin/package.json
Remove @types/uuid — uuid is not used anywhere in the source code.

STEP 2: Remove @platform/shared-ui alias (LOW-10)
Read: web/modules/tenant-admin/vite.config.ts
Read: web/modules/tenant-admin/tsconfig.json
Remove the @platform/shared-ui path alias from both files — it's defined but never imported.

STEP 3: Remove TenantAdminSidebar.tsx (LOW-14)
Read: web/modules/tenant-admin/src/components/TenantAdminSidebar.tsx
Verify it's only used in standalone mode (not imported in Module.tsx or any production route).
Delete the file. Remove any import of it from index.ts.

STEP 4: Memoize UI primitives (LOW-02, LOW-04)
Read: web/modules/tenant-admin/src/components/ui/StatusBadge.tsx (created in Task 9)
Read: web/modules/tenant-admin/src/components/ui/RoleBadge.tsx
Ensure ALL extracted UI components are wrapped with React.memo.
For HealthGauge (if it exists), add React.memo wrapper.
Move statusConfig/roleConfig objects OUTSIDE the component (module-level const) to prevent
recreation on every render.

STEP 5: Memoize toggleUserSelection/toggleAllSelection (LOW-05)
Read: web/modules/tenant-admin/src/components/users/BulkActions.tsx (created in Task 9)
Wrap toggle handlers in useCallback with proper dependency arrays.

STEP 6: formatLastSeen deduplication (LOW-03)
Search for formatLastSeen or formatRelativeTime across tenant-admin source.
If a utility version exists in shared-ui (e.g., date-utils.ts), import from there.
If inline versions exist in page files, replace with the shared utility import.

STEP 7: Device polling exponential backoff (LOW-08)
Read: web/modules/tenant-admin/src/hooks/useDevicePolling.ts
Add exponential backoff on query failure:
```typescript
const { data, error } = useQuery({
  queryKey: tenantKeys.devices.detail(deviceId),
  queryFn: () => api.getDevice(deviceId),
  refetchInterval: (query) => {
    if (query.state.error) {
      // Exponential backoff: 10s, 20s, 40s, max 60s
      const failCount = query.state.errorUpdateCount;
      return Math.min(10000 * Math.pow(2, failCount), 60000);
    }
    return intervalMs;
  },
  enabled: !!deviceId,
});
```

STEP 8: Extract RequireTenantAdmin guard (LOW-15)
Read: web/modules/tenant-admin/src/Module.tsx
Find the inline auth guard component. Extract it to:
Create: web/modules/tenant-admin/src/components/RequireTenantAdmin.tsx
Import it back in Module.tsx.

STEP 9: Fix useFocusTrap for nested modals (LOW-17)
Read: web/modules/tenant-admin/src/hooks/useFocusTrap.ts
The current implementation can create conflicting event listeners when modals are nested.
FIX: Track a stack of active traps. Only the topmost trap should handle keyboard events.
Use a module-level stack:
```typescript
const trapStack: HTMLElement[] = [];
// On activate: push to stack
// On deactivate: pop from stack
// Only handle events if this trap is on top of the stack
```

STEP 10: Implement sanitizeErrorMessage (LOW-07)
Create: web/modules/tenant-admin/src/lib/error-handling.ts
```typescript
export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Strip internal details (SQL, stack traces, schema names)
    const msg = error.message;
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) return 'Service temporarily unavailable';
    if (msg.includes('duplicate key')) return 'This record already exists';
    if (msg.includes('violates not-null')) return 'Required field is missing';
    if (msg.includes('relation') && msg.includes('does not exist')) return 'Service configuration error';
    return msg.length > 200 ? msg.slice(0, 200) + '...' : msg;
  }
  return 'An unexpected error occurred';
}
```
Replace all raw error.message displays with sanitizeErrorMessage(error) calls.

STEP 11: includeInternal client-controlled parameter (LOW-06)
Read: web/modules/tenant-admin/src/services/tenantApi.ts (or lib/api.ts after Task 4)
Find any API call that passes includeInternal=false as a parameter.
Add a comment: // SEC: includeInternal is client-controlled; backend MUST enforce this
This is a documentation/awareness fix — the actual enforcement must be on the backend.

STEP 12: Update eslint-plugin-react-hooks constraint (LOW-12)
Read: web/modules/tenant-admin/package.json
Update eslint-plugin-react-hooks from ^4.6.0 to ^5.0.0 to match what's actually installed.

STEP 13: Update react/react-dom constraint (LOW-13)
Update react and react-dom from ^18.2.0 to ^18.3.0 to match what's actually installed.

STEP 14: InstallerKeyModal data fetching (LOW-16)
Read: web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx
If the component directly fetches data (not via props or hooks), refactor to accept
data via props or use a hook. Components should not mix presentation with data fetching.

TypeScript check + commit.
```

---

### Task 16: Comprehensive E2E test suite

**Files:**
- Create: `e2e/tests/modules/tenant-admin/tenant-users.spec.ts`
- Create: `e2e/tests/modules/tenant-admin/tenant-modules.spec.ts`
- Create: `e2e/tests/modules/tenant-admin/tenant-billing.spec.ts`
- Update existing E2E tests from earlier tasks

**Agent Prompt:**
```
COMPREHENSIVE E2E TEST SUITE for all tenant-admin functionality.

IMPORTANT: These tests run against the LIVE production server (app.suderra.com).
Use Playwright. Login credentials are in environment variables:
  process.env.E2E_TENANT_ADMIN_EMAIL (default: okan@oceanfarm.eu)
  process.env.E2E_TENANT_ADMIN_PASSWORD
Check e2e/.env or e2e/playwright.config.ts for how credentials are loaded.

Test suite structure:

1. tenant-users.spec.ts:
- User list loads successfully (no 400/500 errors)
- User filter by status works
- Create user with valid data succeeds
- Create user with invalid data shows error
- Edit user role works
- Bulk deactivate works with confirmation
- Pagination works correctly

2. tenant-modules.spec.ts:
- Module list loads with correct data
- Module manager assignment works
- Module manager removal works

3. tenant-billing.spec.ts:
- Billing page loads without errors
- Plan information displays correctly
- Subscription details render

4. Update tenant-settings.spec.ts (from Task 1):
- All settings sections render
- General settings save works
- Notification preferences persist
- Security/Localization show "Coming Soon"

5. Update tenant-security.spec.ts (from Task 7):
- Database browser restricted to own schema
- Provisioning key requires safety limits with autoApprove

6. Update tenant-communication.spec.ts (from Task 2):
- Messages page loads
- Support tickets page loads
- Announcements page loads

Each test should:
- Assert no console errors (page.on('console'))
- Assert no 400/500 network responses (page.on('response'))
- Verify actual data rendering, not just page load

TypeScript check + commit.
```

---

## Execution Summary

| Phase | Tasks | Findings Covered | Commit Points |
|-------|-------|-----------------|---------------|
| P0 — Critical | 1-6 | 6 CRIT + 2 HIGH | 6 |
| P1 — High | 7-11 | 14 HIGH | 5 |
| P2 — Medium | 12-14 | 24 MEDIUM | 3 |
| P3 — Low + E2E | 15-16 | 17 LOW + E2E suite | 2 |
| **Total** | **16 tasks** | **63 findings** | **16 commits** |

All 63 L2 findings are covered: 6 CRITICAL, 16 HIGH, 24 MEDIUM, 17 LOW.

Each agent receives the FULL context: file paths, exact code to write, verification commands, and commit instructions. No shortcuts, no assumptions.

**Note:** Task 13 includes cross-module fixes (shared-ui Sidebar, farm-module MapView/Species, docker-compose TRUST_PROXY) that were discovered during the tenant-admin audit but affect shared infrastructure. These are justified as cross-cutting concerns that directly impact tenant-admin UX.
