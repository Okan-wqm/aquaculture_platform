/**
 * @aquaculture/backend-common/guards
 *
 * Defense-in-depth guard layers (ADR-008). RolesGuard, TenantGuard,
 * TenantPermissionGuard, ServiceIdentityGuard — plus token-revocation
 * service used transitively.
 *
 * WHY no re-export of jwks.service here: JwksService is an internal
 * implementation detail of ServiceIdentityGuard. Consumers import
 * ServiceIdentityGuard via this barrel; JwksService deep-imports only.
 */

export * from './roles.guard';
export * from './tenant.guard';
export * from './tenant-permission.guard';
export * from './service-identity.guard';
export * from './token-revocation.service';
// SEC-HIGH-052: mobile feature-entitlement guard (paired with @RequiresMobileFeature)
export * from './mobile-feature.guard';
export * from './destructive-action.guard';
