# Discovery Log

Findings discovered during code review by Agent 3 (Admin API Architect).

## 2026-03-22 — Cross-Schema Write Audit (admin-api-service)

### Context
Grepped for `INSERT INTO auth.`, `UPDATE auth.`, `DELETE FROM auth.`, and `CREATE TABLE ... auth.` across all admin-api-service source files.

### HIGH: Direct INSERT INTO auth.* tables from admin-api-service

These cross-schema writes violate single-writer ownership. The auth-service should own all writes to auth.* tables; admin-api should delegate via NATS commands.

| File | Line | Table | Notes |
|------|------|-------|-------|
| `src/tenant/services/tenant-provisioning.service.ts` | 650 | `auth.tenant_roles` | INSERT role during provisioning. TODO(NATS-MIGRATION) marker added. |
| `src/tenant/services/tenant-provisioning.service.ts` | 941 | `auth.users` | INSERT admin user during provisioning. TODO(NATS-MIGRATION) marker added. |
| `src/tenant/services/tenant-provisioning.service.ts` | 960 | `auth.invitations` | INSERT invitation during provisioning. TODO(NATS-MIGRATION) marker added. |
| `src/tenant/services/tenant-provisioning.service.ts` | 1025 | `auth.tenant_modules` | INSERT modules during provisioning. TODO(NATS-MIGRATION) marker added. |
| `src/users/services/user-provisioning.service.ts` | 107 | `auth.users` | INSERT user during user provisioning |
| `src/users/services/user-provisioning.service.ts` | 127 | `auth.invitations` | INSERT invitation |
| `src/users/services/user-provisioning.service.ts` | 301 | `auth.users` | INSERT user (bulk path) |
| `src/users/services/user-provisioning.service.ts` | 329 | `auth.invitations` | INSERT invitation (bulk path) |
| `src/users/services/user-provisioning.service.ts` | 362 | `auth.user_module_assignments` | INSERT module assignment |
| `src/users/users.service.ts` | 412 | `auth.users` | INSERT user (direct service) |
| `src/modules/modules.service.ts` | 323 | `auth.modules` | INSERT module definition |
| `src/modules/modules.service.ts` | 599, 624 | `auth.tenant_modules` | INSERT module assignment |
| `src/modules/tenant-management/services/module-assignment.service.ts` | 193, 488 | `auth.tenant_modules` | INSERT module assignment |

### HIGH: Direct UPDATE auth.* tables from admin-api-service

| File | Line | Table | Notes |
|------|------|-------|-------|
| `src/auth/password-reset.controller.ts` | 83, 177 | `auth.users` | UPDATE password reset token |
| `src/auth/password-reset.controller.ts` | 185 | `auth.refresh_tokens` | UPDATE refresh tokens |
| `src/billing/services/subscription-core.service.ts` | 519 | `auth.tenants` | UPDATE tenant plan/limits |
| `src/billing/services/subscription-plan-change.service.ts` | 123 | `auth.tenants` | UPDATE tenant on plan change |
| `src/tenant/services/tenant-provisioning.service.ts` | 164, 332, 973 | `auth.tenants` | UPDATE tenant status/user_count |
| `src/users/services/user-provisioning.service.ts` | 142, 379 | `auth.tenants` | UPDATE tenant user_count |
| `src/users/users.service.ts` | 483, 525, 578 | `auth.users` | UPDATE user fields |
| `src/modules/tenant-management/services/module-assignment.service.ts` | 182, 305, 514 | `auth.tenant_modules` | UPDATE module assignment |
| `src/modules/modules.service.ts` | 403 | `auth.modules` | UPDATE module definition |

### HIGH: Direct DELETE FROM auth.* tables from admin-api-service

| File | Line | Table | Notes |
|------|------|-------|-------|
| `src/tenant/services/tenant-provisioning.service.ts` | 197, 245, 306, 312 | various auth.* | Compensation DELETEs (saga rollback) |
| `src/users/users.service.ts` | 554 | `auth.refresh_tokens` | DELETE refresh tokens on user deactivation |
| `src/modules/modules.service.ts` | 443, 710 | `auth.modules`, `auth.tenant_modules` | DELETE module/assignment |

### HIGH: Direct DDL on auth schema

| File | Line | Table | Notes |
|------|------|-------|-------|
| `src/tenant/services/tenant-provisioning.service.ts` | 694 | `auth.tenant_roles` | CREATE TABLE IF NOT EXISTS — should be a migration |

### MED: TenantStatus enum in analytics/entities/external/tenant.entity.ts

The analytics service has its own `TenantStatus` enum at `src/analytics/entities/external/tenant.entity.ts` with only 4 values (ACTIVE, SUSPENDED, PENDING, CANCELLED). This is separate from the main tenant entity's enum which now has 6 values. The analytics enum may need updating to include DEACTIVATED and ARCHIVED for accurate reporting.

### MED: Raw SQL analytics queries use hardcoded status strings

`src/analytics/services/analytics.service.ts` line 179 uses `'CANCELLED'` and `'SUSPENDED'` as hardcoded string literals in raw SQL. If the canonical status values change, these queries would silently produce wrong results.

### LOW: Password reset controller directly modifies auth.users

`src/auth/password-reset.controller.ts` performs direct UPDATEs to `auth.users` for password reset tokens. This should ideally be routed through auth-service via NATS.
