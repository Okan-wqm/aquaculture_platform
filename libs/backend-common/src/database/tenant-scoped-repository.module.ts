import { DynamicModule, Module, Provider, Inject } from '@nestjs/common';
import { DataSource, ObjectLiteral, EntityTarget } from 'typeorm';

import { TenantEntity } from './tenant-entity.interface';
import { TenantScopedRepository } from './tenant-scoped-repository';

/**
 * Unique prefix for tenant-scoped repository injection tokens.
 * Used by @InjectTenantRepository() and TenantScopedRepositoryModule.
 */
export const TENANT_SCOPED_REPO_PREFIX = 'TENANT_SCOPED_REPO_';

function entityTargetName<T extends ObjectLiteral>(entity: EntityTarget<T>): string {
  if (typeof entity === 'function') {
    return entity.name;
  }
  if (typeof entity === 'string') {
    return entity;
  }
  if ('options' in entity && typeof entity.options.name === 'string') {
    return entity.options.name;
  }
  if ('name' in entity && typeof entity.name === 'string') {
    return entity.name;
  }
  throw new TypeError('Tenant repository entity target has no stable name');
}

/**
 * Generate the DI token for a tenant-scoped repository.
 *
 * @param entity - Entity class (e.g. SensorDataChannel)
 * @returns Injection token string
 */
export function getTenantRepoToken<T extends ObjectLiteral>(entity: EntityTarget<T>): string {
  const name = entityTargetName(entity);
  return `${TENANT_SCOPED_REPO_PREFIX}${name}`;
}

/**
 * Parameter decorator for injecting a TenantScopedRepository into a service.
 *
 * @example
 * ```typescript
 * constructor(
 *   @InjectTenantRepository(SensorDataChannel)
 *   private readonly channelRepo: TenantScopedRepository<SensorDataChannel>,
 * ) {}
 * ```
 *
 * @param entity - Entity class to create a scoped repository for
 * @returns NestJS parameter decorator
 */
export function InjectTenantRepository<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
): ParameterDecorator {
  return Inject(getTenantRepoToken(entity));
}

/**
 * TenantScopedRepositoryModule — registers TenantScopedRepository providers for entities.
 *
 * This module creates a TenantScopedRepository<T> for each registered entity.
 * The repository resolves tenantId from AsyncLocalStorage (set by
 * RequestContextMiddleware for HTTP or withTenantContext() for MQTT/cron).
 *
 * # Usage
 *
 * ```typescript
 * @Module({
 *   imports: [
 *     TypeOrmModule.forFeature([SensorDataChannel, SensorReading]),
 *     TenantScopedRepositoryModule.forFeature([SensorDataChannel, SensorReading]),
 *   ],
 * })
 * export class SensorModule {}
 * ```
 *
 * # Why forFeature() and not forRoot()?
 *
 * Each bounded context (service module) imports only the entities it owns.
 * forFeature() registers tenant-scoped repositories for exactly those entities,
 * following NestJS's TypeOrmModule.forFeature() convention.
 *
 * # Scope
 *
 * The providers are NOT request-scoped. TenantScopedRepository reads tenantId
 * from AsyncLocalStorage at METHOD CALL TIME, not at construction time. This
 * means:
 *   - No Scope.REQUEST overhead (no per-request DI tree reconstruction)
 *   - Works in MQTT/cron/NATS contexts where there is no Express Request
 *   - The same instance handles multiple tenants in sequence (cron iterating tenants)
 */
@Module({})
export class TenantScopedRepositoryModule {
  /**
   * Register TenantScopedRepository providers for the given entities.
   *
   * @param entities - Array of TypeORM entity classes
   * @returns DynamicModule with providers and exports for each entity
   */
  static forFeature<T extends TenantEntity>(entities: EntityTarget<T>[]): DynamicModule {
    const providers: Provider[] = entities.map((entity) => ({
      provide: getTenantRepoToken(entity),
      useFactory: (dataSource: DataSource): TenantScopedRepository<T> => {
        return TenantScopedRepository.create(dataSource, entity);
      },
      inject: [DataSource],
    }));

    return {
      module: TenantScopedRepositoryModule,
      providers,
      exports: providers.map((p) => (p as { provide: string }).provide),
    };
  }
}
