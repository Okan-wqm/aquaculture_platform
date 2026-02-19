---
name: tenant-admin
description: Knowledge base for the Tenant Admin frontend module
---

# Tenant Admin Knowledge Base

## Overview

The Tenant Admin module is a Module Federation remote accessible to `TENANT_ADMIN` (and `SUPER_ADMIN`) at `/tenant/*`. It provides tenant-level management: user management, module assignments, communication (messages/support/announcements), database inspection, edge device management, roles/permissions, and tenant settings.

## Directory Structure

```
web/modules/tenant-admin/src/
  Module.tsx              # Route definitions
  main.tsx
  vite-env.d.ts
  pages/
    TenantDashboard.tsx          # /tenant (index) — stats + modules overview
    TenantUsers.tsx              # /tenant/users — user list + invite
    TenantModules.tsx            # /tenant/modules — module assignment + manager
    TenantSettings.tsx           # /tenant/settings — tenant profile/settings
    TenantDatabase.tsx           # /tenant/database — schema/table browser
    TenantMessagesPage.tsx       # /tenant/messages — messaging with platform
    TenantSupportPage.tsx        # /tenant/support — support ticket submission
    TenantAnnouncementsPage.tsx  # /tenant/announcements — platform announcements
    EdgeDevicesPage.tsx          # /tenant/devices — edge device list
    EdgeDeviceDetailPage.tsx     # /tenant/devices/:deviceId — device detail
    TenantRolesPage.tsx          # Roles management (not in Module.tsx routes yet)
    index.ts
  components/
    TenantAdminLayout.tsx        # Inner layout wrapper (for standalone mode)
    TenantAdminHeader.tsx        # Header for standalone mode
    TenantAdminSidebar.tsx       # Sidebar (for standalone mode; Shell provides nav in production)
    ErrorBoundary.tsx
    TableSchemaModal.tsx         # Database table schema inspector modal
    TableDataModal.tsx           # Database table data viewer modal
    common/
      DeleteConfirmModal.tsx
      index.ts
    permissions/
      PermissionCheckboxGroup.tsx # Permission toggle checkboxes
      index.ts
    roles/
      RoleCard.tsx               # Role display card
      RoleModal.tsx              # Create/edit role modal
      DeleteRoleModal.tsx
      index.ts
    users/
      AddEditUserModal.tsx       # Add or edit user modal
      index.ts
    devices/
      InstallerKeyModal.tsx      # Generate edge device installer key
    index.ts
  hooks/
    useTenantData.ts             # Generic tenant data fetcher
    useTenantRoles.ts            # Roles CRUD hook
    useDevicePolling.ts          # Polling hook for device status
    useFocusTrap.ts              # Accessibility focus trap for modals
    index.ts
  services/
    tenantApi.ts                 # REST API for tenant operations
    tenant-api.service.ts        # Alternative service layer
    graphql-queries.ts           # All GraphQL query/mutation strings
    index.ts
  types/
    permissions.ts               # Permission type definitions
  utils/
    error-handling.ts            # Error message normalization
```

## Pages / Components

### TenantDashboard (`/tenant`)
Overview stats card grid:
- Total users / active users / pending users
- Total modules / active modules
- Active sessions, monthly growth %, last activity
Uses `TENANT_STATS_QUERY` and `MY_TENANT_QUERY`.

### TenantUsers (`/tenant/users`)
User list with status/role filters. Actions:
- Invite new user (`AddEditUserModal`)
- Edit user role/status
- Deactivate/reactivate user
Uses `TENANT_USERS_QUERY`, invite mutation.

### TenantModules (`/tenant/modules`)
Lists modules assigned to the tenant. Allows assigning a `MODULE_MANAGER` per module via `ASSIGN_MODULE_MANAGER_MUTATION` / `REMOVE_MODULE_MANAGER_MUTATION`.
Uses `MY_TENANT_MODULES_QUERY`.

### TenantDatabase (`/tenant/database`)
Schema inspection:
- Lists all tables in tenant schema via `TENANT_DATABASE_QUERY`
- `TableSchemaModal` shows columns + indexes via `TABLE_SCHEMA_QUERY`
- `TableDataModal` shows paginated rows via `TABLE_DATA_QUERY`
- Read-only — no data editing from this UI

### EdgeDevicesPage (`/tenant/devices`)
Lists edge devices registered to this tenant. `useDevicePolling` polls device status at interval.
`InstallerKeyModal` generates a one-time installer key for new edge device setup.

### EdgeDeviceDetailPage (`/tenant/devices/:deviceId`)
Detailed status of a single edge device: connection status, last heartbeat, configuration, logs.

### TenantSettings (`/tenant/settings`)
Editable tenant profile: name, description, logo URL, contact email/phone, address.
Uses `UPDATE_TENANT_SETTINGS_MUTATION`.

### Communication Pages
- **TenantMessagesPage** (`/tenant/messages`): View/send messages from/to platform support
- **TenantSupportPage** (`/tenant/support`): Submit and track support tickets
- **TenantAnnouncementsPage** (`/tenant/announcements`): Read platform announcements posted by SUPER_ADMIN

## State Management

- No Zustand store
- Local `useState` for modal open/close, filter state
- `useTenantData` hook: generic wrapper over `fetch` for tenant API calls
- `useDevicePolling`: `setInterval`-based polling with cleanup
- Direct GraphQL via `graphqlClient` from `@aquaculture/shared-ui`

## GraphQL Operations

All queries/mutations are centralized in `services/graphql-queries.ts`:

```graphql
query MyTenant { myTenant { id name slug description logoUrl contactEmail contactPhone address status plan maxUsers settings createdAt updatedAt } }
query TenantStats { tenantStats { totalUsers activeUsers pendingUsers inactiveUsers totalModules activeModules activeSessions monthlyGrowthPercent lastActivityAt } }
query MyTenantModules { myTenantModules { id moduleId isEnabled configuration activatedAt expiresAt managerId module { id code name description icon category isActive } } }
query TenantUsers($status, $role, $limit, $offset) { tenantUsers { id email firstName lastName role status lastLoginAt createdAt } }
query TenantDatabase { tenantDatabase { databaseName schemaName totalSize tableCount status lastBackup activeConnections maxConnections tables { name rowCount size indexCount lastModified } } }
query TableSchema($schemaName, $tableName) { tableSchema { tableName schemaName columns { columnName dataType isNullable isPrimaryKey isForeignKey foreignKeyTable foreignKeyColumn } indexes { ... } } }
query TableData($input: GetTableDataInput!) { tableData { tableName totalRows columns rows offset limit } }
mutation AssignModuleManager($input) { assignModuleManager { id moduleId managerId } }
mutation RemoveModuleManager($moduleId) { removeModuleManager { id moduleId managerId } }
mutation UpdateTenantSettings($input) { updateTenantSettings { id name description logoUrl contactEmail settings updatedAt } }
```

## Routing

```
/tenant                   -> TenantDashboard
/tenant/users             -> TenantUsers
/tenant/modules           -> TenantModules
/tenant/messages          -> TenantMessagesPage
/tenant/support           -> TenantSupportPage
/tenant/announcements     -> TenantAnnouncementsPage
/tenant/settings          -> TenantSettings
/tenant/devices           -> EdgeDevicesPage
/tenant/devices/:deviceId -> EdgeDeviceDetailPage
/tenant/database          -> TenantDatabase
```

Note: `TenantRolesPage` exists in the pages directory but is not registered in `Module.tsx` routes yet.

## Key Dependencies

- `@aquaculture/shared-ui` — graphqlClient, useAuthContext, shared components
- Vite + Module Federation
- Tailwind CSS

## Known Gotchas

- `TenantAdminSidebar.tsx` is a standalone-mode sidebar. In production, the Shell's `MainLayout` provides navigation. The sidebar component is not mounted in the federated route.
- `TABLE_DATA_QUERY` input uses `GetTableDataInput!` which requires both `schemaName` and `tableName` separately (not combined as `schema.table`).
- `TenantRolesPage` is implemented but not registered in `Module.tsx` — add route if needed.
- Edge device installer key generation via `InstallerKeyModal` integrates with the edge provisioning flow (sens-api-gateway).
- `useDevicePolling` uses `setInterval` — ensure cleanup on unmount to avoid memory leaks.
- `useFocusTrap` is a local accessibility hook for modal keyboard navigation.
- Error messages are normalized via `utils/error-handling.ts` — use `sanitizeErrorMessage()` when displaying errors.

## Related Backend Services

- **auth-service** — user management, invitation within tenant
- **farm-service** — tenant schema operations
- **gateway-api** (port 3000) — all GraphQL requests
- **sens-api-gateway** / edge provisioning — edge device registration and installer keys
