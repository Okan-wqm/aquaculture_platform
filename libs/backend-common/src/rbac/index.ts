/**
 * @aquaculture/backend-common/rbac
 *
 * Faz 7 tenant-configurable RBAC foundation: the capability catalogue (SSoT) and
 * the effective-capability resolver. Sits under the existing permission
 * primitive (`@RequireTenantPermission` + `TenantPermissionGuard`).
 */
export * from './capabilities';
export * from './permission-resolver';
