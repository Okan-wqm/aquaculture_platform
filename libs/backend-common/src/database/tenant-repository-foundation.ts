import type { EntityTarget, ObjectLiteral, Repository } from 'typeorm';

/**
 * The narrow TypeORM primitive shared by DataSource and EntityManager.
 *
 * This is intentionally internal to backend-common's tenant repository
 * implementation. Application code receives TenantScopedRepository and never
 * the raw repository returned here.
 */
interface TypeOrmRepositoryProvider {
  getRepository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity>;
}

/**
 * Resolve the raw TypeORM repository exactly once, at the tenant-isolation
 * foundation boundary. Both DataSource-scoped and transaction-scoped factories
 * delegate here so acquisition cannot drift between the two entry points.
 */
export function resolveTenantRepositoryFoundation<T extends ObjectLiteral>(
  provider: TypeOrmRepositoryProvider,
  entity: EntityTarget<T>,
): Repository<T> {
  const resolveRepository = provider.getRepository.bind(provider);
  return resolveRepository(entity);
}
