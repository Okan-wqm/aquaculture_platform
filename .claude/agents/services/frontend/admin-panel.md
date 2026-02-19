---
name: admin-panel
description: Knowledge base for the Admin Panel frontend module (SUPER_ADMIN only)
---

# Admin Panel Knowledge Base

## Overview

The Admin Panel is a Module Federation remote accessible only to `SUPER_ADMIN` users at `/admin/*`. It provides comprehensive system management: tenant lifecycle, user and role management, billing/subscriptions, support tools, security monitoring, system administration, and database exploration.

## Directory Structure

```
web/modules/admin-panel/src/
  Module.tsx              # Route definitions for all admin pages
  App.tsx                 # Standalone dev wrapper
  bootstrap.tsx           # MF bootstrap
  main.tsx
  routes.tsx              # (empty — routes are in Module.tsx)
  styles.css
  services/
    adminApi.ts           # REST API client for admin operations
  hooks/
    usePagination.ts
    useFilters.ts
    useAsyncData.ts
    useUserPermissions.ts
    index.ts
    __tests__/
  components/
    AdminLayout.tsx        # Admin-specific inner layout (may wrap page content)
    AdminSidebar.tsx       # Admin sidebar navigation component
    AlertRuleBuilder/
      AlertRuleBuilder.tsx # Visual alert rule builder component
      index.ts
    UserPermissions/
      InviteUserModal.tsx
      PermissionCheckboxes.tsx
    database/
      QueryEditor.tsx      # SQL query editor
      RowEditor.tsx        # Row edit modal
      SchemaSelector.tsx
      SchemaStatistics.tsx
      TableList.tsx
      DataGrid.tsx
      index.ts
    index.ts
  pages/
    AdminDashboard.tsx             # /admin (index)
    AnalyticsDashboardPage.tsx     # /admin/analytics
    ReportsPage.tsx                # /admin/analytics/reports
    TenantManagementPage.tsx       # /admin/tenants
    CreateTenantPage.tsx           # /admin/tenants/new
    TenantDetailPage.tsx           # /admin/tenants/:tenantId
    TenantConfigurationPage.tsx    # /admin/tenants/:tenantId/configuration
    UserManagementPage.tsx         # /admin/users
    RoleManagementPage.tsx         # /admin/users/roles
    ModulesPage.tsx                # /admin/modules
    BillingDashboardPage.tsx       # /admin/billing
    SubscriptionManagementPage.tsx # /admin/billing/subscriptions
    InvoicesPage.tsx               # /admin/billing/invoices
    PlanManagementPage.tsx         # /admin/billing/plans
    DiscountCodePage.tsx           # /admin/billing/discounts
    ModulePricingPage.tsx          # /admin/billing/module-pricing
    CustomPlanBuilderPage.tsx      # /admin/billing/custom-plan-builder
    TicketsPage.tsx                # /admin/support/tickets
    MessagingPage.tsx              # /admin/support/messaging
    AnnouncementsPage.tsx          # /admin/support/announcements
    OnboardingPage.tsx             # /admin/support/onboarding
    AuditLogPage.tsx               # /admin/audit
    SystemSettingsPage.tsx         # /admin/settings
    EmailTemplatesPage.tsx         # /admin/settings/email
    IpAccessRulesPage.tsx          # /admin/settings/integrations
    ProvisioningSettingsPage.tsx   # /admin/settings/provisioning
    DatabaseManagementPage.tsx     # /admin/database
    DatabaseExplorerPage.tsx       # /admin/database/explorer
    security/
      SecurityDashboardPage.tsx    # /admin/security/threats
      ActivityLogPage.tsx          # /admin/security/activity
      AuditTrailPage.tsx           # /admin/security/audit
      CompliancePage.tsx           # /admin/security/compliance
      index.ts
    system/
      FeatureTogglesPage.tsx       # /admin/system/features
      MaintenancePage.tsx          # /admin/system/maintenance
      PerformanceDashboardPage.tsx # /admin/system/performance
      ErrorTrackingPage.tsx        # /admin/system/errors
      JobQueuePage.tsx             # /admin/system/jobs
      ImpersonationPage.tsx        # /admin/system/impersonation
      DebugToolsPage.tsx           # /admin/system/debug
      index.ts
    __tests__/
      CreateTenantPage.spec.tsx
      TenantManagementPage.spec.tsx
```

## Pages / Components

### Tenant Management
- **TenantManagementPage**: Paginated list of all tenants with status filters
- **CreateTenantPage**: Multi-step wizard to provision a new tenant (name, plan, modules, admin user)
- **TenantDetailPage**: Individual tenant dashboard, stats, modules, users
- **TenantConfigurationPage**: Per-tenant configuration overrides

### Billing
- **BillingDashboardPage**: Revenue overview, MRR, churn metrics
- **SubscriptionManagementPage**: All subscriptions with status
- **InvoicesPage**: Invoice list, download, mark paid
- **PlanManagementPage**: Subscription plan CRUD
- **DiscountCodePage**: Discount code management
- **ModulePricingPage**: Per-module pricing configuration
- **CustomPlanBuilderPage**: Visual plan builder for custom enterprise plans

### Security
- **SecurityDashboardPage**: Threat detection, suspicious login attempts
- **ActivityLogPage**: User activity stream
- **AuditTrailPage**: Immutable audit trail viewer
- **CompliancePage**: GDPR/compliance checklist

### System
- **FeatureTogglesPage**: Feature flag management (per-tenant or global)
- **MaintenancePage**: Maintenance mode toggle, scheduled downtime
- **PerformanceDashboardPage**: API response times, DB query stats
- **ErrorTrackingPage**: Frontend/backend error aggregator
- **JobQueuePage**: Background job queue status (BullMQ)
- **ImpersonationPage**: Admin can impersonate any tenant user
- **DebugToolsPage**: Raw API testing, cache clear, etc.

### Database
- **DatabaseManagementPage**: Schema list, table sizes, backup status
- **DatabaseExplorerPage**: Interactive SQL query editor + data grid (`QueryEditor`, `DataGrid`, `RowEditor`, `SchemaSelector`, `TableList`)

### AlertRuleBuilder
Visual rule builder component for creating alert threshold rules. Supports conditions, operators, and actions.

## State Management

- Custom hooks: `usePagination`, `useFilters`, `useAsyncData`, `useUserPermissions`
- `useAsyncData`: generic async data loading hook with loading/error state
- `usePagination`: page/pageSize state management
- `useFilters`: URL-param-aware filter state
- No Zustand; no React Query (uses `useAsyncData` pattern instead)

## GraphQL Operations

Admin panel calls the `adminApi.ts` service for REST operations and direct GraphQL for queries. Key operations:

```graphql
# Tenant management
query Tenants($status, $limit, $offset) { tenants { id name status plan createdAt } }
mutation CreateTenant($input: CreateTenantInput!) { createTenant { id name schemaName } }
mutation UpdateTenantStatus($tenantId, $status) { updateTenantStatus { id status } }

# User management
query Users($tenantId, $role, $status) { users { id email role status lastLoginAt } }
mutation InviteUser($input: InviteUserInput!) { inviteUser { id email } }
mutation UpdateUserRole($userId, $role) { updateUserRole { id role } }
mutation ImpersonateUser($userId) { impersonateUser { accessToken } }

# Billing
query Subscriptions { subscriptions { tenantId plan status currentPeriodEnd } }
query Invoices($tenantId) { invoices { id amount status dueDate } }

# System
query FeatureFlags { featureFlags { key enabled description tenantOverrides } }
mutation ToggleFeatureFlag($key, $enabled) { toggleFeatureFlag { key enabled } }
query JobQueues { jobQueues { name waiting active completed failed } }
```

## Routing

```
/admin                          -> AdminDashboard
/admin/analytics                -> AnalyticsDashboardPage
/admin/analytics/reports        -> ReportsPage
/admin/tenants                  -> TenantManagementPage
/admin/tenants/new              -> CreateTenantPage
/admin/tenants/:tenantId        -> TenantDetailPage
/admin/tenants/:tenantId/configuration -> TenantConfigurationPage
/admin/users                    -> UserManagementPage
/admin/users/roles              -> RoleManagementPage
/admin/modules                  -> ModulesPage
/admin/billing                  -> BillingDashboardPage
/admin/billing/subscriptions    -> SubscriptionManagementPage
/admin/billing/invoices         -> InvoicesPage
/admin/billing/plans            -> PlanManagementPage
/admin/billing/discounts        -> DiscountCodePage
/admin/billing/module-pricing   -> ModulePricingPage
/admin/billing/custom-plan-builder -> CustomPlanBuilderPage
/admin/support/tickets          -> TicketsPage
/admin/support/messaging        -> MessagingPage
/admin/support/announcements    -> AnnouncementsPage
/admin/support/onboarding       -> OnboardingPage
/admin/security/activity        -> ActivityLogPage
/admin/security/audit           -> AuditTrailPage
/admin/security/compliance      -> CompliancePage
/admin/security/threats         -> SecurityDashboardPage
/admin/system/features          -> FeatureTogglesPage
/admin/system/maintenance       -> MaintenancePage
/admin/system/performance       -> PerformanceDashboardPage
/admin/system/errors            -> ErrorTrackingPage
/admin/system/jobs              -> JobQueuePage
/admin/system/impersonation     -> ImpersonationPage
/admin/system/debug             -> DebugToolsPage
/admin/database                 -> DatabaseManagementPage
/admin/database/explorer        -> DatabaseExplorerPage
/admin/audit                    -> AuditLogPage
/admin/settings                 -> SystemSettingsPage
/admin/settings/email           -> EmailTemplatesPage
/admin/settings/integrations    -> IpAccessRulesPage
/admin/settings/provisioning    -> ProvisioningSettingsPage
```

## Key Dependencies

- `@aquaculture/shared-ui` — shared components and auth context
- Webpack Module Federation (uses webpack, not Vite)
- Tailwind CSS
- Custom `usePagination`, `useFilters`, `useAsyncData` hooks (local to module)

## Known Gotchas

- This module uses **webpack** (`webpack.config.js`), not Vite — build and federation config differ from other modules.
- `routes.tsx` is empty — all routes are defined in `Module.tsx` directly.
- `AdminSidebar.tsx` exists as a component but the actual sidebar used is Shell's `MainLayout` sidebar. AdminSidebar may be used for standalone dev mode only.
- Role enforcement: `ProtectedRoute` in Shell wraps `/admin/*` with `requiredRoles: ['SUPER_ADMIN']`. The module itself does NOT re-check roles.
- `ImpersonationPage` returns a temporary access token — consuming code must then reload with the new token.
- `DatabaseExplorerPage` sends raw SQL via the API — should only be used in admin context.
- Test files exist: `CreateTenantPage.spec.tsx`, `TenantManagementPage.spec.tsx`, `AlertRuleBuilder.spec.tsx`.

## Related Backend Services

- **auth-service** — user management, invitation, impersonation
- **billing-service** — subscriptions, invoices, plans
- **admin-api-service** (or gateway-api admin routes) — tenant provisioning, system settings
- **gateway-api** (port 3000) — all requests go through here
