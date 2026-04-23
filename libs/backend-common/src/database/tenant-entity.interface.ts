import type { ObjectLiteral } from 'typeorm';

/**
 * Base entity interface with a `tenantId` string column.
 *
 * Canonical anchor for every per-tenant entity in the platform.
 * `TenantScopedRepository<T extends TenantEntity>` and all companion
 * decorators (`@InjectTenantRepository`, `TenantScopedRepositoryModule`)
 * depend on this constraint to statically require a `tenantId` column
 * exists on every persisted row they see.
 *
 * This file used to live inline inside `tenant-aware.repository.ts`
 * (now @deprecated). It was extracted so downstream imports do not
 * transitively pull in the deprecated request-scoped repository class.
 */
export interface TenantEntity extends ObjectLiteral {
  tenantId: string;
}
