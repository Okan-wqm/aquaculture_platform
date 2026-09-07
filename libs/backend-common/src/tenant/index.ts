/**
 * @aquaculture/backend-common/tenant
 *
 * Tenant-scoped constants (GLOBAL_TENANT_UUID, etc.). Import one level
 * above the repository layer if you only need the tenant-id literal.
 */

export * from './constants';
// ADMIN-CRITICAL-009: the one resolution point from a client-supplied tenant id to a verified tenant.
export * from './verified-tenant.pipe';
