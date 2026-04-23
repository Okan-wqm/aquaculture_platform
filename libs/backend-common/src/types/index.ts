/**
 * @aquaculture/backend-common/types
 *
 * Canonical shared request + DI interfaces. This barrel is the only
 * import site for `TenantRequest` — middleware's extended shape remains
 * deep-import so the two don't collide.
 */

export * from './tenant-request.interface';
