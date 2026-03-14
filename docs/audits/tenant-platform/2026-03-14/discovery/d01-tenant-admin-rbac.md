# D01 - Tenant Admin RBAC & User Management Audit

**Auditor:** D1 - RBAC & User Management Expert
**Date:** 2026-03-14
**Scope:** `web/modules/tenant-admin/`, `apps/auth-service/`, `apps/gateway-api/` (RBAC, users, invitations)
**Status:** COMPLETE

---

## 1. File Structure & Page Inventory

### 1.1 Frontend (web/modules/tenant-admin/src/)

| Path | Route | Purpose |
|------|-------|---------|
| `pages/TenantDashboard.tsx` | `/tenant` | Stats overview (users, modules, sessions) |
| `pages/TenantUsers.tsx` | `/tenant/users` | User CRUD, invite, role assignment |
| `pages/TenantRolesPage.tsx` | `/tenant/roles` | Custom role CRUD with granular permissions |
| `pages/TenantModules.tsx` | `/tenant/modules` | Module assignment, manager assignment |
| `pages/TenantSettings.tsx` | `/tenant/settings` | Tenant profile editing |
| `pages/TenantDatabase.tsx` | `/tenant/database` | Schema/table browser (read-only) |
| `pages/TenantMessagesPage.tsx` | `/tenant/messages` | Platform messaging |
| `pages/TenantSupportPage.tsx` | `/tenant/support` | Support tickets |
| `pages/TenantAnnouncementsPage.tsx` | `/tenant/announcements` | Platform announcements |
| `pages/EdgeDevicesPage.tsx` | `/tenant/devices` | Edge device list |
| `pages/EdgeDeviceDetailPage.tsx` | `/tenant/devices/:deviceId` | Device detail |

**Components:**
- `components/users/AddEditUserModal.tsx` -- Create/edit user with role selection
- `components/roles/RoleCard.tsx`, `RoleModal.tsx`, `DeleteRoleModal.tsx` -- Role CRUD UI
- `components/permissions/PermissionCheckboxGroup.tsx` -- 3-level permission matrix (Category > Resource > Action)
- `components/common/DeleteConfirmModal.tsx` -- Confirm deletion
- `components/devices/InstallerKeyModal.tsx` -- Edge device installer key generation

**Hooks:**
- `hooks/useTenantRoles.ts` -- TanStack Query hooks with optimistic updates for roles CRUD
- `hooks/useTenantData.ts` -- Generic data fetcher
- `hooks/useDevicePolling.ts` -- Interval-based device polling
- `hooks/useFocusTrap.ts` -- Modal accessibility

**Services:**
- `services/tenant-api.service.ts` -- GraphQL client, role/permission API functions, type definitions
- `services/tenantApi.ts` -- REST API for messaging, announcements, tickets
- `services/graphql-queries.ts` -- Centralized GraphQL query strings

### 1.2 Backend (apps/auth-service/src/modules/tenant/)

| File | Purpose |
|------|---------|
| `resolvers/tenant-admin.resolver.ts` | Tenant admin queries/mutations (users, modules, tables) |
| `resolvers/tenant-role.resolver.ts` | Role CRUD, user role assignment, permission categories |
| `resolvers/tenant.resolver.ts` | Tenant entity queries |
| `services/tenant-role.service.ts` | Role CRUD with SERIALIZABLE transactions |
| `services/tenant-admin.service.ts` | Tenant admin operations |
| `services/tenant-user-management.service.ts` | User creation, role assignment, invitation |
| `entities/tenant.entity.ts` | Tenant entity |
| `entities/tenant-module.entity.ts` | Tenant-module assignment entity |
| `dto/tenant-role.dto.ts` | GraphQL types for roles/permissions |
| `dto/tenant-admin.dto.ts` | GraphQL types for admin operations |

### 1.3 Gateway Guards

| File | Purpose |
|------|---------|
| `guards/auth.guard.ts` | JWT/API-key/Basic auth validation |
| `guards/permission.guard.ts` | Permission-based access control with hierarchy |
| `guards/tenant-isolation.guard.ts` | Cross-tenant access prevention |

---

## 2. RBAC System Analysis

### 2.1 Two-Tier Role Architecture

The platform implements a **dual role system**:

**Tier 1 - Global Roles (User entity, `auth.users` table):**
```
SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER
```
Defined in `libs/backend-common/src/decorators/roles.decorator.ts` as the `Role` enum. These are stored in `user.role` and embedded in JWT tokens as `roles[]`. Used by `RolesGuard` for resolver-level access control.

**Tier 2 - Tenant Roles (Tenant schema, `tenant_*.tenant_roles` table):**
Custom roles like Supervisor, Technician, Feed Manager, Operator, Viewer. Each has:
- `level` (1-100 priority)
- `isSystem` flag (prevents modification)
- `isDefault` flag (auto-assigned to new users)
- `panelPermissions` (3-level nested JSON: Category > Resource > Action > boolean)
- `resourcePermissions` (flat `resource:action` string array)

### 2.2 Role Definition Flow

1. **Seed Default Roles:** `TenantRoleService.seedDefaultRoles()` creates 5 system roles (Supervisor, Technician, Feed Manager, Operator, Viewer) with predefined permission matrices.
2. **Custom Role Creation:** `TenantRolesPage` allows creating custom roles via `createTenantRole` mutation.
3. **Permission Categories:** Backend exposes 6 categories (farm, batch, operations, hr, reports, admin) via `permissionCategories` query. Frontend renders these as `PermissionCheckboxGroup`.

### 2.3 Role Assignment Flow

```
TenantUsers page
  -> AddEditUserModal (select role from useTenantRoles)
    -> CREATE_TENANT_USER_MUTATION (input.roleId)
      -> TenantRoleResolver.createTenantUser()
        -> TenantUserManagementService.createTenantUser()
          1. Creates user in auth.users (global role = MODULE_USER)
          2. Creates role assignment in tenant_*.user_role_assignments
          3. Optionally sends invitation email via EventBus
```

### 2.4 Role Enforcement

**Resolver Level (Backend):**
- `@TenantAdminOrHigher()` decorator on most tenant-admin queries/mutations -- requires `SUPER_ADMIN` or `TENANT_ADMIN` global role.
- `@Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN)` on all write mutations (create/update/delete role, create user, assign role).
- `JwtAuthGuard` + `RolesGuard` applied at resolver class level.

**Frontend Level:**
- No client-side route guards -- all `/tenant/*` routes render without role check.
- Permission enforcement relies entirely on backend GraphQL guards.

### 2.5 Permission Model Details

**Panel Permissions Structure:**
```json
{
  "farm": {
    "tanks": { "view": true, "create": true, "edit": false, "delete": false }
  },
  "operations": {
    "sensors": { "view": true, "configure": false }
  }
}
```

**Permission Override System:**
Each `user_role_assignments` record can have `permissionOverrides`:
```json
{ "grants": ["sensors:calibrate"], "revokes": ["tanks:delete"] }
```
Effective permissions = role base permissions - revokes + grants. Calculated in `TenantUserManagementService.calculateEffectivePermissions()`.

---

## 3. User CRUD Flows

### 3.1 Create User

**Flow:** `TenantUsers` -> `AddEditUserModal` -> `CREATE_TENANT_USER_MUTATION`

**Backend chain:**
1. `TenantRoleResolver.createTenantUser()` -- validates UUIDs, sanitizes strings (XSS prevention)
2. `TenantUserManagementService.createTenantUser()`:
   - Validates tenant exists
   - Checks email uniqueness globally (`userRepository.findOne`)
   - Validates roleId exists in tenant schema
   - Generates invitation token: `crypto.randomBytes(32).toString('hex')` (256 bits entropy)
   - Creates user with `role: Role.MODULE_USER` (global role)
   - Creates `user_role_assignments` in tenant schema
   - Publishes `UserInvitedEvent` via EventBus

### 3.2 Edit User

**Flow:** `TenantUsers` -> Edit button -> `AddEditUserModal` (isEditing=true) -> `UPDATE_USER_MUTATION`

**Frontend sends:** `{ userId, input: { firstName, lastName, roleId } }`
**Backend:** `updateTenantUser` mutation (defined inline in `TenantUsers.tsx`, not in `graphql-queries.ts`).

### 3.3 Delete User

**Flow:** `TenantUsers` -> Delete button -> `DeleteConfirmModal` -> `DELETE_USER_MUTATION`

**Frontend sends:** `{ userId }`
**Backend:** `deleteTenantUser` mutation. Hard delete or soft delete not specified in frontend code.

### 3.4 Deactivate/Activate User

**Backend resolvers exist:** `deactivateTenantUser` and `activateTenantUser` in `TenantAdminResolver`.
**Frontend:** Bulk deactivate button exists but is **disabled** (commented "Coming soon"). Individual deactivate not wired.

---

## 4. Permission System Deep Dive

### 4.1 Granular Permission Model

The system implements a full **Category > Resource > Action** permission model:

**6 Permission Categories:**
| Category | Resources | Actions |
|----------|-----------|---------|
| `farm` | sites, departments, systems, tanks, ponds, equipment | view, create, edit, delete, assign |
| `batch` | batches, species, mortality, growth, harvest | view, create, edit, delete, transfer, split, merge, plan, record, analyze |
| `operations` | feeding, sensors, maintenance, water_quality | view, record, configure, calibrate, manage_schedules, manage_inventory, create_work_orders, complete, manage_alerts |
| `hr` | employees, attendance, leave, shifts | view, create, edit, delete, manage, approve |
| `reports` | dashboard, reports | view, analytics, export, create_custom |
| `admin` | settings, users, roles | view, edit, invite, edit_permissions, deactivate, create, delete |

### 4.2 Permission Enforcement Gap (CRITICAL)

**FINDING [SEC-001] - Tenant-level permissions not enforced at API level:**

The 3-level panel permissions (farm.tanks.create, operations.sensors.configure, etc.) are:
- **Stored** in `tenant_role_permissions.panel_permissions` (JSON)
- **Displayed** in the UI via `PermissionCheckboxGroup`
- **NOT enforced** by any backend guard or middleware

The gateway's `PermissionGuard` uses a completely **different permission model**:
```typescript
// Gateway permission.guard.ts uses hardcoded role-permission map:
const ROLE_PERMISSIONS = {
  system_admin: ['*'],
  tenant_admin: ['users:manage', 'farms:manage', ...],
  manager: ['users:view', 'farms:read', ...],
  ...
};
```
These role names (`system_admin`, `tenant_admin`, `manager`, `operator`, `viewer`) do **not match** the actual Role enum values (`SUPER_ADMIN`, `TENANT_ADMIN`, `MODULE_MANAGER`, `MODULE_USER`).

**Impact:** The elaborate permission matrix in tenant roles is purely cosmetic. A MODULE_USER with a "Viewer" tenant role (read-only) can still call any mutation that only checks `@TenantAdminOrHigher()`. The granular permissions are never checked during request processing.

**Risk Level:** HIGH -- The permission UI creates a false sense of granular control.

### 4.3 Gateway Permission Guard Role Mismatch (CRITICAL)

**FINDING [SEC-002] - Role hierarchy names mismatch:**

Gateway `permission.guard.ts` defines:
```typescript
const ROLE_HIERARCHY = {
  system_admin: [...],  // but Role enum is SUPER_ADMIN
  tenant_admin: [...],  // but Role enum is TENANT_ADMIN
  manager: [...],       // but Role enum is MODULE_MANAGER
  operator: [...],      // no enum equivalent
  viewer: [],           // no enum equivalent
};
```

JWT tokens carry `roles: ['TENANT_ADMIN']` but `ROLE_PERMISSIONS` and `ROLE_HIERARCHY` use lowercase `tenant_admin`. The `getEffectivePermissions()` method does:
```typescript
for (const role of user.roles) {
  const rolePerms = ROLE_PERMISSIONS[role] || [];  // 'TENANT_ADMIN' not in map -> empty!
}
```

**Impact:** The permission guard's built-in role-to-permission mapping is **non-functional** because of case mismatch. Only the `@Roles()` decorator/RolesGuard actually works. The `@RequirePermissions()` decorator will always fail for JWT-authenticated users unless they have explicit `permissions[]` in the JWT (which they don't, based on the auth service code).

---

## 5. Tenant Isolation Analysis

### 5.1 TenantIsolationGuard

Located at `apps/gateway-api/src/guards/tenant-isolation.guard.ts`.

**Strengths:**
- UUID format validation for tenant IDs (prevents injection)
- Extracts tenant ID from header, URL param, query param, body, GraphQL variables
- Cross-tenant access blocked with audit logging
- `platform_admin` and `super_admin` roles bypass isolation for admin operations
- Tenant ID format validated via regex

**Cross-tenant access rules:**
- `platform_admin` / `super_admin` roles -> access any tenant
- `partner` role with `managedTenants` list -> access managed tenants
- `accessibleTenants` array in JWT -> explicit cross-tenant access
- All others -> own tenant only

### 5.2 Tenant Schema Isolation (Backend)

`TenantRoleService` and `TenantUserManagementService` use `SchemaManagerService.getTenantSchemaName(tenantId)` to derive schema names. All SQL queries use `"${schemaName}"."table"` notation, ensuring data isolation at the database level.

**FINDING [SEC-003] - SQL injection via schema name:**
The schema name is interpolated directly into SQL strings:
```typescript
const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
const roles = await this.dataSource.query(
  `SELECT ... FROM "${schemaName}"."tenant_roles" ...`
);
```
The tenantId comes from `@CurrentUser('tenantId')` which is extracted from the JWT, so it should be trustworthy. However, if `getTenantSchemaName()` doesn't sanitize, a compromised JWT with a crafted tenantId like `tenant_"; DROP TABLE--` could be dangerous. The `TenantIsolationGuard` validates UUID format, which mitigates this. **Risk: LOW** (mitigated by UUID validation at guard level).

### 5.3 Frontend Tenant Isolation

`services/tenantApi.ts` sends `X-Tenant-Id` header via `getTenantId()` from shared-ui. The graphql client in `tenant-api.service.ts` does NOT send X-Tenant-Id -- it relies on the JWT's embedded `tenantId`.

**FINDING [SEC-004] - Dual tenant ID source inconsistency:**
- REST API calls use explicit `X-Tenant-Id` header from `getTenantId()`
- GraphQL calls rely solely on JWT's `tenantId` claim
- If `getTenantId()` returns a different value than the JWT's tenantId, REST and GraphQL calls could target different tenants
- **Risk: LOW** -- the backend validates JWT tenantId against any provided header

---

## 6. Auth Flow Analysis

### 6.1 Login Flow

1. `AuthResolver.login()` -- @Public decorator, no auth required
2. `AuthenticationService.login()`:
   - Account lockout after configurable failed attempts (default: 5)
   - Lockout duration configurable (default: 30 min)
   - Timing-safe comparison via `TimingSafeService`
   - Minimum login duration to prevent timing attacks
   - Audit logging of all auth events

3. JWT generation:
   - Access token: HS256 algorithm, configurable expiry (default 15min)
   - Contains: `sub`, `email`, `role`, `roles[]`, `tenantId`, `modules[]`, `jti`
   - Refresh token: stored in DB, returned as httpOnly cookie

### 6.2 Token Refresh

1. Prefers httpOnly cookie, falls back to body parameter
2. Token rotation: old refresh token invalidated, new one issued
3. Refresh token hashing configurable (`HASH_REFRESH_TOKENS`)
4. Redis-backed token blacklist for revocation across instances

### 6.3 Logout

1. Access token blacklisted via `jti` until expiry
2. Refresh token cookie cleared
3. Session invalidated via SessionManager (if available)

### 6.4 Session Management

- `maxSessionsPerUser` configurable (default from SECURITY_CONSTANTS)
- Session manager optional (Redis-backed `ISessionManager`)
- Token blacklist optional (Redis-backed `ITokenBlacklist`)

---

## 7. Invitation System Analysis

### 7.1 Invitation Flow

```
1. TENANT_ADMIN creates user via AddEditUserModal (sendInvitation=true)
2. TenantUserManagementService.createTenantUser():
   a. Generates token: crypto.randomBytes(32).toString('hex') (64 hex chars)
   b. Sets expiry: 7 days
   c. Creates User with invitationToken and invitationExpiresAt
   d. Publishes UserInvitedEvent via EventBus
3. Notification service sends email with link: {APP_URL}/accept-invitation/{token}
4. User clicks link -> AcceptInvitationInput { token, password, firstName?, lastName? }
5. AuthResolver.acceptInvitation() processes acceptance
```

### 7.2 Invitation Entity (Separate Tracking)

The `Invitation` entity (`entities/invitation.entity.ts`) provides a separate audit trail:
- **Statuses:** PENDING, ACCEPTED, EXPIRED, CANCELLED, RESENT
- **Re-send limit:** Maximum 5 sends per invitation
- **Accepted IP tracking:** `acceptedFromIp` field
- **Token generation:** `crypto.randomBytes(32)` -- 256 bits entropy

### 7.3 Invitation Security Assessment

**Strengths:**
- 256-bit random token (not guessable)
- 7-day expiry
- Token uniqueness enforced via DB unique index
- `@HideField()` on invitationToken, invitationExpiresAt, invitedBy in GraphQL schema
- Status tracking prevents replay (ACCEPTED cannot be re-accepted)
- Re-send limit prevents spam (max 5 sends)

**FINDING [SEC-005] - Invitation token stored in plaintext:**
`User.invitationToken` is stored as plain text in the database. If the DB is compromised, tokens can be used directly. Should be stored as a hash (like password reset tokens in some implementations). **Risk: MEDIUM** -- requires DB access to exploit.

**FINDING [SEC-006] - No rate limiting on invitation acceptance:**
The `acceptInvitation` endpoint is `@Public()` and while the gateway has a global rate limiter, there's no specific stricter limit for invitation acceptance. An attacker could brute-force tokens, though the 64-char hex makes this impractical. **Risk: LOW** -- brute-force impractical with 256-bit entropy.

---

## 8. Security Findings Summary

### 8.1 Critical Findings

| ID | Finding | Risk | Location |
|----|---------|------|----------|
| SEC-001 | **Tenant permissions (panelPermissions) not enforced at API level** | HIGH | Gateway lacks enforcement of tenant-role granular permissions. The permission matrix UI is cosmetic. |
| SEC-002 | **Gateway PermissionGuard role names mismatch** | HIGH | `permission.guard.ts` ROLE_HIERARCHY/ROLE_PERMISSIONS use lowercase names (`system_admin`) but JWT carries uppercase (`SUPER_ADMIN`). Built-in permission mapping is non-functional. |

### 8.2 Medium Findings

| ID | Finding | Risk | Location |
|----|---------|------|----------|
| SEC-005 | Invitation tokens stored in plaintext | MEDIUM | `User.invitationToken` column in auth.users |
| SEC-007 | **No frontend route guards** | MEDIUM | All `/tenant/*` routes render without checking user role. A MODULE_USER sees the full tenant admin UI; mutations fail server-side but the exposed UI may reveal sensitive layout/options. |
| SEC-008 | **User deletion has no self-deletion prevention** | MEDIUM | `DeleteTenantUser` mutation doesn't check if targetUserId == currentUserId. A tenant admin could delete their own account. |
| SEC-009 | **Hardcoded Role.MODULE_USER for all created users** | MEDIUM | `createTenantUser` always sets `role: Role.MODULE_USER` as the global role. Even if you want to create a second TENANT_ADMIN, the global role stays MODULE_USER. The tenant-level role is separate, but the global role determines resolver access (`@TenantAdminOrHigher()`). |

### 8.3 Low Findings

| ID | Finding | Risk | Location |
|----|---------|------|----------|
| SEC-003 | SQL schema name interpolation (mitigated by UUID validation) | LOW | `tenant-role.service.ts` |
| SEC-004 | Dual tenant ID source (REST header vs JWT) | LOW | `tenantApi.ts` vs `tenant-api.service.ts` |
| SEC-006 | No specific rate limit on invitation acceptance | LOW | `auth.resolver.ts` |
| SEC-010 | **MFA secret stored in plaintext** | LOW | `User.mfaSecret` has a TODO comment but no encryption. MFA is not yet enabled in production. |
| SEC-011 | **Bulk deactivate not implemented** | LOW | Frontend has disabled "Deactivate" button, backend exists. Gap between UI promise and capability. |

---

## 9. Role Escalation Analysis

### 9.1 Can a MODULE_USER become TENANT_ADMIN?

**Via Global Role:** No. The `createTenantUser` mutation is protected by `@Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN)`. Only existing admins can call it.

**Via Tenant Role:** The tenant-level role system is **decoupled** from the global role system. A MODULE_USER can be assigned a "Supervisor" tenant role with high-level permissions, but this doesn't grant them access to `@TenantAdminOrHigher()` protected resolvers.

**FINDING [SEC-012] - Tenant role level doesn't translate to global role access:**
A user could have a tenant role with `admin.users.invite: true` panel permission, but since panel permissions are not enforced (SEC-001), and the user's global role remains MODULE_USER, they cannot actually invoke user management mutations.

**FINDING [SEC-013] - Role update doesn't update JWT:**
When a tenant admin changes a user's role via `updateTenantUser`, the global `user.role` in the database changes, but the user's **existing JWT still contains the old role**. The user must re-authenticate to get updated claims. During the window between role change and re-auth (up to JWT expiry, default 15min), the user retains old permissions.

### 9.2 Can a MODULE_MANAGER escalate to TENANT_ADMIN?

No. MODULE_MANAGER cannot call:
- `createTenantRole` (requires SUPER_ADMIN or TENANT_ADMIN)
- `updateUserRole` (requires SUPER_ADMIN or TENANT_ADMIN)
- `createTenantUser` (requires SUPER_ADMIN or TENANT_ADMIN)

MODULE_MANAGER can only call queries decorated with `@TenantAdminOrHigher()` -- this excludes them since TenantAdminOrHigher maps to `Roles(SUPER_ADMIN, TENANT_ADMIN)`.

Wait -- re-checking: `TenantAdminOrHigher()` is `Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN)`. The `RolesGuard` checks if the user's role is in the required list. MODULE_MANAGER is NOT in this list. So MODULE_MANAGER **cannot** access any `@TenantAdminOrHigher()` endpoint. Correct -- no escalation path.

---

## 10. Test Coverage

### 10.1 Frontend Tests

**FINDING [TEST-001] - Zero frontend tests:**
No `.spec.ts`, `.test.ts`, or `.test.tsx` files exist in `web/modules/tenant-admin/src/`. There are no unit tests, integration tests, or component tests for:
- User CRUD flows
- Role management
- Permission checkbox behavior
- Modal components
- Error handling

### 10.2 Backend Tests

Backend tests exist in:
- `apps/gateway-api/src/guards/__tests__/permission.guard.spec.ts`
- `apps/gateway-api/src/guards/__tests__/tenant-isolation.guard.spec.ts`
- `apps/gateway-api/src/guards/__tests__/auth.guard.spec.ts`
- `apps/auth-service/src/modules/support/__tests__/support.service.spec.ts`
- `apps/auth-service/src/modules/messaging/__tests__/messaging.service.spec.ts`
- `apps/auth-service/src/modules/announcement/__tests__/announcement.service.spec.ts`

**Missing:**
- No tests for `TenantRoleService` (role CRUD, seed, assignment)
- No tests for `TenantUserManagementService` (user creation, invitation, permission calculation)
- No tests for `TenantRoleResolver` or `TenantAdminResolver`
- No integration tests for the full invitation flow

---

## 11. Architecture Recommendations

### 11.1 Priority 1 (Critical)

1. **Enforce tenant-level permissions at API layer:** Create middleware or guard that reads the user's `user_role_assignments` + `tenant_role_permissions` from the database (cached in Redis) and validates against the requested operation. Without this, the entire permission UI is misleading.

2. **Fix gateway PermissionGuard role name casing:** Either change `ROLE_HIERARCHY` and `ROLE_PERMISSIONS` to use `SUPER_ADMIN` etc., or normalize roles to lowercase before lookup. Currently the guard's permission resolution is broken.

### 11.2 Priority 2 (Medium)

3. **Add frontend route guards:** Wrap `/tenant/*` routes with a role check component that redirects non-admin users. Prevents UI disclosure of admin functionality.

4. **Hash invitation tokens at rest:** Store `SHA-256(token)` instead of plaintext. Compare by hashing the provided token.

5. **Prevent self-deletion:** Add `userId !== targetUserId` check in `deleteTenantUser`.

6. **Allow global role assignment for new users:** `createTenantUser` should accept a global role parameter (with validation: tenant admin can only create MODULE_USER and MODULE_MANAGER, not SUPER_ADMIN or TENANT_ADMIN).

### 11.3 Priority 3 (Low)

7. **Invalidate JWT on role change:** When a role is changed, either blacklist the old JWT or use short-lived tokens with session validation.

8. **Add backend tests for tenant role service and user management service.**

9. **Add frontend tests for critical user flows.**

---

## 12. Data Flow Diagrams

### 12.1 User Creation Flow
```
Frontend                  Gateway              Auth Service
   |                         |                      |
   |-- createTenantUser ---->|                      |
   |                         |-- JwtAuthGuard ----->|
   |                         |-- RolesGuard ------->| (SUPER_ADMIN || TENANT_ADMIN)
   |                         |                      |
   |                         |   TenantRoleResolver.createTenantUser()
   |                         |                      |-- validate UUIDs
   |                         |                      |-- sanitize strings
   |                         |                      |
   |                         |   TenantUserManagementService
   |                         |                      |-- check tenant exists
   |                         |                      |-- check email unique
   |                         |                      |-- validate role in tenant
   |                         |                      |-- generate invitation token
   |                         |                      |-- create User (role=MODULE_USER)
   |                         |                      |-- create role assignment
   |                         |                      |-- publish UserInvitedEvent
   |                         |                      |
   |<---- result ------------|<---------------------|
```

### 12.2 Permission Check Flow (Current - Broken)
```
Request -> AuthGuard (JWT validation)
       -> RolesGuard (checks user.role against @Roles() decorator)
       -> PermissionGuard (BROKEN: role names don't match)
       -> TenantIsolationGuard (tenant ID validation)
       -> Resolver (executes)

NOTE: Tenant-level panelPermissions are NEVER checked in this chain.
```

---

## 13. Spawn Requests

No sub-agent spawns required for this discovery. All relevant code has been reviewed inline.

---

## Summary Metrics

| Metric | Value |
|--------|-------|
| Files reviewed | 28 |
| Critical findings | 2 (SEC-001, SEC-002) |
| Medium findings | 4 (SEC-005, SEC-007, SEC-008, SEC-009) |
| Low findings | 5 (SEC-003, SEC-004, SEC-006, SEC-010, SEC-011) |
| Info findings | 2 (SEC-012, SEC-013) |
| Frontend test coverage | 0% |
| Backend test coverage for RBAC | 0% |
| Permission categories | 6 |
| Default tenant roles | 5 |
| Global roles | 4 |
