---
name: admin-api-service
description: Knowledge base for admin-api-service - Tenant provisioning, schema migration, analytics, billing plan management, system tools. REST API only (no GraphQL).
---

# Admin API Service Knowledge Base

## Overview
The admin-api-service is the platform management layer used by super admins. It handles tenant provisioning (the critical `POST /tenants` flow that creates schemas, users, and configures all modules), database schema migration management, cross-tenant analytics, billing plan definitions, system settings, security management, impersonation/debug tools, and user/role management. Uses REST API (no GraphQL). Uses CQRS internally.

## Directory Structure
```
apps/admin-api-service/src/
  app.module.ts              # Root - TypeORM (admin schema), CQRS, Redis, ThrottlerModule
  main.ts
  filters/
    global-exception.filter.ts
  guards/
    platform-admin.guard.ts  # Global guard - only SUPER_ADMIN can access
  shared/
    response.interceptor.ts  # Standardized API response format
    __tests__/performance/
      cacheable-decorator.spec.ts
      pagination-helpers.spec.ts
  decorators/
    current-user.decorator.ts
    public.decorator.ts
    roles.decorator.ts
  lifecycle/
    graceful-shutdown.service.ts

  tenant/                    # Tenant provisioning and management
    tenant.module.ts
    tenant.controller.ts     # REST endpoints for tenant CRUD
    commands/
      tenant.commands.ts     # CreateTenantCommand, etc.
    services/
      tenant-activity.service.ts    # Tracks tenant activity events
      tenant-detail.service.ts      # Get tenant details with analytics
    entities/
      tenant-activity.entity.ts
    modules/
      tenant-management/
        services/
          tenant-provisioning.service.ts  # THE CRITICAL SERVICE - orchestrates provisioning
          schema-migration.service.ts     # Manages schema migrations per tenant
    __tests__/
      create-tenant.handler.spec.ts
      tenant-provisioning.service.spec.ts
      tenant-api.integration.spec.ts
      tenant-creation.spec.ts
      tenant-isolation-fixes.spec.ts
      tenant.e2e.spec.ts
      tenant.security.spec.ts
      performance/
        list-tenants-pagination.spec.ts
        tenant-stats-caching.spec.ts

  users/                     # User and role management
    users.module.ts
    users.controller.ts
    users.service.ts
    services/
      tenant-role.service.ts         # Manage custom roles per tenant
      user-permissions.service.ts    # Permission evaluation
      user-provisioning.service.ts   # Create/invite users
      user-role-assignment.service.ts  # Assign roles to users
      role-template.service.ts       # Pre-built role templates
    entities/
      tenant-role.entity.ts
      tenant-role-permissions.entity.ts
      user-role-assignment.entity.ts
      user-permissions.entity.ts
    dto/
      invite-user.dto.ts
    __tests__/
      user-permissions.spec.ts

  billing/                   # Billing plan management
    billing.module.ts
    entities/
      plan-definition.entity.ts     # Plan definitions (Starter/Pro/Enterprise)
      plan-module-assignment.entity.ts  # Which modules are in each plan
      module-pricing.entity.ts      # Per-module pricing
      custom-plan.entity.ts         # Custom plan overrides per tenant
      discount-code.entity.ts       # Discount/promo codes
      pricing-metric.enum.ts
    services/
      subscription-types.ts

  analytics/                 # Cross-tenant analytics
    analytics.module.ts
    controllers/
      analytics.controller.ts
      reports.controller.ts
    services/
      analytics.service.ts    # Platform-wide analytics aggregation
      reports.service.ts      # Report generation
    entities/
      analytics-snapshot.entity.ts  # Cached analytics snapshots
      external/                     # Read-only views of other schemas
        tenant.entity.ts            # Reads from auth schema
        user.entity.ts              # Reads from auth schema
        subscription.entity.ts      # Reads from billing schema
        invoice.entity.ts           # Reads from billing schema
    __tests__/performance/
      reports-caching.spec.ts

  audit/                     # Audit log management
    audit.module.ts
    audit.service.ts
    audit.entity.ts

  auth/                      # Admin-level password reset
    password-reset.module.ts
    password-reset.controller.ts
    __tests__/
      password-reset.security.spec.ts

  database-management/       # Schema migration tools
    database-management.module.ts
    entities/
      database-management.entity.ts

  health/
    health.module.ts

  impersonation/             # Admin impersonation and debug tools
    impersonation.module.ts
    entities/
      impersonation-session.entity.ts  # Records who impersonated whom
      debug-session.entity.ts
    services/
      debug-tools-types.ts

  metrics/                   # System metrics
    system-metrics.module.ts
    system-metrics.service.ts

  modules/                   # Platform module management
    modules.module.ts         # Manage which modules exist (farm, sensor, hr, etc.)

  security/                  # Security management
    security.module.ts
    entities/
      security.entity.ts
    controllers/...
    services/...

  settings/                  # System settings
    settings.module.ts
    entities/
      system-setting.entity.ts
      tenant-configuration.entity.ts
    controllers/...
    services/...

  support/                   # Admin support tools
    support.module.ts
    entities/
      support.entity.ts

  system-management/         # System-wide management
    system-management.module.ts
    entities/
      feature-toggle.entity.ts
      maintenance-mode.entity.ts
      system-version.entity.ts
      performance-metric.entity.ts
      error-tracking.entity.ts
      job-queue.entity.ts
```

## Modules & Features

### TenantManagementModule (CRITICAL)
The tenant provisioning flow is orchestrated by `TenantProvisioningService`:

**Provisioning Step Order (MUST maintain this order):**
1. Validate tenant data (uniqueness, plan availability)
2. **Assign modules** (set which modules are enabled for this tenant) - MUST happen BEFORE schema creation
3. Create tenant schema (`tenant_{first16chars_uuid}`)
4. Create PostgreSQL roles and permissions
5. Create tenant configuration records
6. Create admin user (via auth-service API)
7. Send welcome email (via notification-service NATS event)
8. Activate tenant (set `isActive = true`)

`SchemaMigrationService`: manages per-tenant schema migrations when new module tables are added.

**Key insight**: Module assignment MUST happen before schema creation because `SchemaManagerService` in `libs/backend-common` queries `tenant_modules` to determine which tables to create.

### UsersModule
- CRUD for users within tenants (admin perspective)
- Custom role management: define roles per tenant with specific permissions
- Role templates: pre-built roles (Farm Manager, Feeder, Technician, etc.)
- User provisioning: creates users via auth-service
- Permission evaluation: what can a specific user do?

### BillingModule (Admin)
- Manages plan definitions (not the same as billing-service)
- Plan-to-module assignments
- Per-module pricing overrides
- Custom plans for enterprise clients
- Discount codes

### AnalyticsModule
- Platform-wide analytics: tenant count, active users, revenue
- Cross-schema reads: has `external/` entities that read from auth, billing schemas
- Analytics snapshots: cached aggregated metrics
- Report generation (exportable)

### DatabaseManagementModule
- Tools for managing schema migrations across all tenant schemas
- Bulk migration execution
- Schema health checks

### ImpersonationModule
- Super admins can impersonate tenant admin users for debugging
- All impersonation sessions are logged
- Debug sessions for support

### SystemManagementModule
- Feature toggles (enable/disable features per tenant or globally)
- Maintenance mode management
- System version tracking
- Performance metrics collection
- Error tracking
- Job queue monitoring

### SecurityModule
- Security policy management
- IP whitelisting, 2FA requirements per tenant

### SettingsModule
- System-wide settings
- Per-tenant configuration overrides

## Key Entities

### PlanDefinition
- `code` (starter, professional, enterprise, custom), `name`
- `limits` (JSONB): maxFarms, maxPonds, maxSensors, maxUsers, dataRetentionDays
- `pricing` (JSONB): basePrice, billingCycles pricing

### TenantRole
- Custom role within a tenant
- `name`, `tenantId`, `permissions` (array)
- Used for per-tenant RBAC beyond the global role hierarchy

### SystemSetting / TenantConfiguration
- Key-value store for system settings
- Tenant-specific config overrides

### FeatureToggle
- `featureName`, `isEnabled`, `tenantId` (null = global)

## API (REST - no GraphQL)
The admin-api-service exposes a REST API (Swagger documented).

### Key Endpoints
```
POST   /tenants                    # Create/provision tenant
GET    /tenants                    # List tenants (paginated)
GET    /tenants/:id                # Get tenant details
PUT    /tenants/:id                # Update tenant
DELETE /tenants/:id                # Deactivate tenant
POST   /tenants/:id/modules        # Add module to tenant
DELETE /tenants/:id/modules/:code  # Remove module from tenant

GET    /users                      # List users (cross-tenant)
POST   /users/invite               # Invite user
PUT    /users/:id/role             # Change user role
DELETE /users/:id                  # Deactivate user

GET    /analytics/dashboard        # Platform dashboard metrics
GET    /analytics/tenants          # Tenant analytics
GET    /reports/revenue            # Revenue reports

GET    /billing/plans              # List plan definitions
POST   /billing/plans              # Create plan
PUT    /billing/plans/:id          # Update plan

POST   /auth/password-reset        # Admin password reset
GET    /health                     # Health check

GET    /metrics/system             # System performance metrics
GET    /system/feature-toggles     # Feature toggle list
PUT    /system/feature-toggles/:name  # Toggle feature

POST   /impersonation/start        # Start impersonation session
POST   /impersonation/end          # End impersonation session
```

## Patterns Used
- **CQRS** via `@nestjs/cqrs` (`CqrsModule` imported)
- **PlatformAdminGuard** globally applied - all endpoints require SUPER_ADMIN role
- **ThrottlerGuard** globally applied - rate limiting
- **Redis** for caching and distributed rate limiting (`keyPrefix: 'admin:'`)
- **ResponseInterceptor** - standardizes all REST responses
- **GracefulShutdown** - handles SIGTERM/SIGINT properly
- **Cross-schema analytics** - reads from auth and billing schemas via TypeORM external entities

## Inter-Service Communication
REST API calls to:
- auth-service: creates admin users during provisioning
- billing-service: creates initial subscription during provisioning (or via NATS)

Publishes NATS events:
- `TenantProvisioned` (-> notification-service for welcome email)
- `TenantSubscriptionRequested` (-> billing-service)
- `TenantDeactivated`

## Key Dependencies
- `@aquaculture/backend-common` - note: uses `@aquaculture/` prefix (not `@platform/`)
- `@nestjs/cqrs` - CQRS
- `@nestjs/throttler` - rate limiting
- Redis for caching
- `@nestjs/swagger` - API documentation
- TypeORM (admin schema, plus cross-schema entity reads)

## Known Gotchas
- **Import path difference** - uses `@aquaculture/backend-common` not `@platform/backend-common`
- **Module assignment before schema creation** - CRITICAL ordering in TenantProvisioningService; violations cause missing tables in tenant schemas
- **SchemaManagerService in libs** - `libs/backend-common/src/database/schema-manager.service.ts` has `MODULE_SCHEMAS` mapping that lists ALL tables per module and `REFERENCE_DATA_TABLES` for lookup data. When adding new entities to any service, their tables must be added here.
- **Cross-schema reads** - analytics entities in `external/` directory read directly from other schemas (auth, billing). These are read-only and should not be modified.
- **PlatformAdminGuard is global** - every endpoint requires SUPER_ADMIN. Use `@Public()` decorator to exempt health check endpoints.
- **No GraphQL** - this service uses REST only; do not add GraphQL module
- **Swagger** - API is documented with Swagger, check `__tests__/api/swagger.spec.ts`

## Related Services
- auth-service: creates users during provisioning
- billing-service: creates subscriptions during provisioning
- libs/backend-common/schema-manager.service.ts: the actual schema creation logic
- notification-service: sends welcome emails after provisioning
