# Admin API Service

Multi-tenant administration microservice for the Aquaculture Platform. Built with NestJS, handles tenant management, user provisioning, and permission-based access control.

## Features

- **Tenant Management**: Create, update, suspend tenants with isolated database schemas
- **Permission-Based Access Control**: Granular checkbox-based permissions (50+ individual permissions)
- **User Management**: Invite users via email, assign permissions
- **Database Schema Management**: Automatic per-tenant schema creation with TimescaleDB support
- **Module Configuration**: Enable/disable features per tenant
- **Super Admin**: Platform-wide administration capabilities

## Architecture

```
src/
├── common/              # Shared utilities, guards, decorators
│   ├── guards/          # Authentication guards (JwtAuthGuard, SuperAdminGuard)
│   └── decorators/      # Custom decorators
├── auth/                # Authentication module (JWT, Super Admin)
├── tenant/              # Tenant management (CQRS)
│   ├── commands/        # CreateTenant, UpdateTenant commands
│   ├── handlers/        # Command handlers
│   ├── services/        # TenantProvisioningService, SchemaManager
│   └── __tests__/       # Comprehensive test suites
├── users/               # User management
│   ├── entities/        # User, UserPermissions
│   ├── services/        # UserPermissionsService
│   └── __tests__/       # Permission system tests
├── modules/             # Module configuration
├── database-management/ # Migration management
└── health/              # Health checks
```

## Security

### Authentication & Authorization

All endpoints are protected with JWT authentication:

```typescript
@UseGuards(JwtAuthGuard)
@Controller('tenants')
export class TenantController { }
```

Super Admin operations require additional guard:

```typescript
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Post()
async createTenant() { }
```

### Permission-Based Access Control (January 2026)

Replaced role-based system (TENANT_ADMIN, TENANT_MANAGER, TENANT_USER) with granular permission-based system:

#### Permission Categories (10 categories, 50+ permissions)

| Category | Permissions |
|----------|-------------|
| **Dashboard** | view, viewAnalytics, exportReports |
| **Farms** | view, create, edit, delete |
| **Batches** | view, create, edit, delete, recordMortality, transfer |
| **Feeding** | view, createRecords, manageSchedules, manageInventory |
| **Sensors** | view, configure, manageAlerts, viewRawData |
| **Maintenance** | view, createWorkOrders, completeWorkOrders, manageSpareParts, manageSchedules |
| **HR** | view, manageEmployees, manageAttendance, manageLeave, viewPayroll, managePayroll |
| **Reports** | view, export, createCustom |
| **Settings** | viewTenantSettings, editTenantSettings, manageIntegrations |
| **Users** | view, invite, editPermissions, deactivate |

#### How It Works

1. **TENANT_ADMIN** is the only role - has all permissions (`['*']`)
2. TENANT_ADMIN invites users via email
3. TENANT_ADMIN assigns granular permissions via checkbox UI
4. Each permission controls access to specific frontend panels and API endpoints

```typescript
// Check if user has specific permission
const canView = await userPermissionsService.hasPermission(
  userId,
  tenantId,
  'farms',
  'view'
);
```

### Multi-Tenancy

- Each tenant gets isolated PostgreSQL schema (`tenant_{uuid16}`)
- Schema names are sanitized to prevent SQL injection
- Advisory locks prevent concurrent schema creation conflicts
- LRU cache for schema validation (1000 entries, 5-min TTL)

### Super Admin Security

- Super admin email validated from environment variable `SUPER_ADMIN_EMAIL`
- No hardcoded credentials
- Separate authentication flow

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `JWT_PUBLIC_KEY` | RSA public key (RS256) — inline PEM. See also `JWT_PUBLIC_KEY_FILE` for path-based load. | Yes |
| `SUPER_ADMIN_EMAIL` | Super admin email address | Yes |
| `ENCRYPTION_KEY` | AES-256 encryption key (min 32 chars) | Yes |
| `CORS_ORIGINS` | Allowed CORS origins | Production |
| `NODE_ENV` | Environment (development/production) | Yes |

## Database

### Multi-Schema Architecture

```
PostgreSQL
├── admin               # Service-owned tables (ADR-011)
├── shared              # Canonical cross-service tables (audit_logs, gdpr_data_requests, user_consents, access_logs)
└── tenant_{uuid16}     # Per-tenant isolated data
    ├── farms           # Farm data
    ├── batches         # Batch data
    ├── sensor_readings # TimescaleDB hypertable
    └── ...
```

### Schema Creation Process

1. Generate sanitized schema name from tenant UUID
2. Acquire advisory lock to prevent race conditions
3. Create schema with `CREATE SCHEMA IF NOT EXISTS`
4. Create all required tables
5. Create TimescaleDB hypertable for sensor_readings
6. Create indexes
7. Release advisory lock

### Entities

> **Retired (2026-07-12, ADR-042):** the `UserPermissions` entity and the
> `shared.user_permissions` table were a dead parallel permission catalog and
> have been removed. User permissions are owned by the auth-service tenant
> RBAC (`auth.tenant_role_permissions.panel_permissions`); archived rows live
> in `admin.retired_config_backups`.

## API Endpoints

### Tenant Management

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/tenants` | Create tenant | SuperAdmin |
| GET | `/api/tenants` | List tenants | SuperAdmin |
| GET | `/api/tenants/:id` | Get tenant | SuperAdmin |
| PATCH | `/api/tenants/:id` | Update tenant | SuperAdmin |
| POST | `/api/tenants/:id/suspend` | Suspend tenant | SuperAdmin |
| POST | `/api/tenants/:id/activate` | Activate tenant | SuperAdmin |

### User Management

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/tenants/:id/users/invite` | Invite user | TENANT_ADMIN |
| GET | `/api/tenants/:id/users` | List users | TENANT_ADMIN |
| GET | `/api/tenants/:id/users/:userId/permissions` | Get permissions | TENANT_ADMIN |
| PATCH | `/api/tenants/:id/users/:userId/permissions` | Update permissions | TENANT_ADMIN |
| POST | `/api/tenants/:id/users/:userId/deactivate` | Deactivate user | TENANT_ADMIN |

### Permission Categories

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/permissions/categories` | Get all permission categories | Authenticated |

## Development

### Prerequisites

- Node.js 18+
- PostgreSQL 14+ with TimescaleDB extension
- pnpm

### Setup

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm run start:dev admin-api-service

# Run tests
pnpm run test admin-api-service

# Build for production
pnpm run build admin-api-service
```

## Testing

```bash
# Unit tests
pnpm run test admin-api-service

# E2E tests
pnpm run test:e2e admin-api-service

# Coverage report
pnpm run test:cov admin-api-service
```

### Test Coverage

| Module | Tests | Coverage | Notes |
|--------|-------|----------|-------|
| Tenant Creation | 57 | ~85% | Comprehensive validation, provisioning |
| User Permissions | 23 | ~90% | CRUD, hasPermission, defaults |
| Schema Manager | 50+ | ~80% | Advisory locks, caching, tables |
| Modules | 15 | ~70% | Configuration tests |
| Migration | 10 | ~60% | Migration management |

### Test Files

- `src/tenant/__tests__/tenant-creation.spec.ts` - Tenant creation workflow
- `src/tenant/__tests__/tenant-provisioning.service.spec.ts` - Provisioning service
- `src/users/__tests__/user-permissions.spec.ts` - Permission system
- `libs/backend-common/src/database/__tests__/schema-manager.spec.ts` - Schema management

## Changelog

### Permission-Based User System (January 2026)

#### Breaking Changes
- Removed `TENANT_MANAGER` and `TENANT_USER` roles
- Replaced role-based access with permission-based access
- Only `TENANT_ADMIN` role exists now

#### New Features
- **UserPermissions Entity**: Stores granular permissions per user per tenant
- **UserPermissionsService**: CRUD operations for permissions
- **Permission Checking**: `hasPermission(userId, tenantId, category, action)`
- **Default Permissions**: Automatic permission creation on user invite
- **Frontend Components**: PermissionCheckboxes, InviteUserModal

#### API Changes
- New endpoint: `POST /api/tenants/:id/users/invite`
- New endpoint: `GET /api/tenants/:id/users/:userId/permissions`
- New endpoint: `PATCH /api/tenants/:id/users/:userId/permissions`
- New endpoint: `GET /api/permissions/categories`

### Multi-Tenancy Audit (January 2026)

#### Security Fixes
- Fixed hardcoded super admin email - now from environment variable
- Added DTO validation for CreateTenantDto (company name, contact)
- Added unique constraint on user_permissions (userId, tenantId)

#### Reliability Improvements
- Implemented `setupDefaultRoles()` - creates TENANT_ADMIN role
- Implemented `createDefaultConfiguration()` - creates tenant settings
- Added advisory locks for schema creation
- Added schema name validation and sanitization

#### Database Schema
- Added `user_permissions` table with JSONB permissions column
- Added indexes for user_permissions lookups
- Added unique constraint on (userId, tenantId)

### Audit Status

| Category | Status | Notes |
|----------|--------|-------|
| Authentication | Pass | JWT + SuperAdmin guards |
| Authorization | Pass | Permission-based access |
| SQL Injection | Pass | Schema sanitization |
| Multi-Tenancy | Pass | Isolated schemas |
| Transaction Management | Pass | Advisory locks, SERIALIZABLE |
| Test Coverage | ~75% | Comprehensive test suites |
| TypeScript | Pass | All errors fixed |

### Known Limitations

- Email sending for invitations is stubbed (needs SMTP configuration)
- Permission changes don't invalidate JWT tokens immediately
- No audit log for permission changes (future enhancement)

## Contributing

1. Follow NestJS best practices
2. Add `@UseGuards(JwtAuthGuard)` to all controllers
3. Use `@Roles()` or permission checks for authorization
4. Add validation decorators to DTOs
5. Write unit tests for services
6. Use transactions for multi-step operations

## License

Proprietary - All rights reserved
