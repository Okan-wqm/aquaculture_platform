import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key for required tenant permissions
 */
export const REQUIRED_TENANT_PERMISSIONS_KEY = 'requiredTenantPermissions';

/**
 * RequireTenantPermission Decorator
 *
 * Marks a route handler as requiring specific tenant-level resource permissions.
 * Used together with TenantPermissionGuard to enforce fine-grained RBAC.
 *
 * Permission format: "resource:action" (e.g., "tanks:create", "sensors:configure")
 *
 * Behaviour:
 * - Opt-in: If the decorator is not present, the guard passes through.
 * - SUPER_ADMIN and TENANT_ADMIN bypass permission checks (full access).
 * - MODULE_MANAGER and MODULE_USER must have every listed permission in their
 *   JWT `resourcePermissions` array.
 *
 * @example
 * ```ts
 * @RequireTenantPermission('tanks:create')
 * @Post()
 * createTank() { ... }
 *
 * @RequireTenantPermission('sensors:configure', 'sensors:calibrate')
 * @Patch(':id/calibrate')
 * calibrateSensor() { ... }
 * ```
 */
export const RequireTenantPermission = (...permissions: string[]) =>
  SetMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, permissions);
