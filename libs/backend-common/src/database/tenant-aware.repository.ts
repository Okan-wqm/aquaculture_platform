import { Injectable, Scope, Inject, Logger } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Repository,
  EntityTarget,
  DataSource,
  ObjectLiteral,
  DeepPartial,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  SelectQueryBuilder,
} from 'typeorm';

import { TenantRequest } from '../types/tenant-request.interface';

import { SchemaManagerService } from './schema-manager.service';
import { TenantEntity } from './tenant-entity.interface';
import { resolveTenantRepositoryFoundation } from './tenant-repository-foundation';

// Re-export so downstream imports like
// `import { TenantEntity } from './tenant-aware.repository'` still resolve.
// The canonical home is now `./tenant-entity.interface`.
export type { TenantEntity };

/**
 * Scoped repository interface that automatically applies tenant filtering.
 * Returned by getScopedRepository().
 *
 * @deprecated — use {@link TenantScopedRepository} from
 *   `./tenant-scoped-repository` for new code. That class provides
 *   full CRUD (save / update / delete / softDelete) and works in both
 *   HTTP and non-HTTP (MQTT, NATS, cron) contexts via
 *   AsyncLocalStorage.
 */
export interface ScopedRepository<T extends TenantEntity> {
  find(options?: FindManyOptions<T>): Promise<T[]>;
  findOne(options: FindOneOptions<T>): Promise<T | null>;
  count(options?: FindManyOptions<T>): Promise<number>;
  createQueryBuilder(alias?: string): SelectQueryBuilder<T>;
}

/**
 * @deprecated
 *
 * Legacy per-request tenant-scoped repository factory.
 *
 * Do NOT use in new code. Use {@link TenantScopedRepository} + the
 * `@InjectTenantRepository(Entity)` decorator from
 * `./tenant-scoped-repository` instead.
 *
 * Reasons to migrate:
 * - This class is REQUEST-scoped (`@Inject(REQUEST)`), so it only works
 *   for HTTP handlers. MQTT listeners, NATS event handlers, and cron
 *   jobs have no Express Request object. `TenantScopedRepository` reads
 *   from AsyncLocalStorage, which HTTP middleware and
 *   `withTenantContext()` both populate.
 * - The `getScopedRepository()` proxy exposes only find / findOne /
 *   count / createQueryBuilder. It is missing save / update / delete,
 *   which was the root cause of ~30 historic findings where developers
 *   fell back to raw `repository.delete()` without tenantId scoping.
 *
 * This class is retained for backwards compatibility of existing tests
 * and transitional callers only. After the cold-audit getRepository
 * migration (AUDIT-HIGH-002/003/007/008) lands, a follow-up commit will
 * delete this class and its tests.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantAwareRepository<T extends TenantEntity> {
  private readonly logger = new Logger(TenantAwareRepository.name);
  private repository: Repository<T>;
  private tenantId: string | null = null;
  private schemaName: string | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly schemaManager: SchemaManagerService,
    @Inject(REQUEST) private readonly request: TenantRequest,
    private readonly entity: EntityTarget<T>,
  ) {
    // Extract tenant ID from request
    this.tenantId = this.extractTenantId();

    if (this.tenantId) {
      this.schemaName = this.schemaManager.getTenantSchemaName(this.tenantId);
    }

    this.repository = resolveTenantRepositoryFoundation(this.dataSource, entity);
  }

  /**
   * Extract tenant ID from trusted sources only.
   *
   * SECURITY (C-03/C-04): Only reads from the JWT-verified user payload and
   * the TenantGuard-validated request property. The X-Tenant-Id header and
   * all other attacker-controlled sources are intentionally excluded to
   * prevent tenant spoofing.
   */
  private extractTenantId(): string | null {
    // 1. JWT-verified tenant claim (highest trust)
    if (this.request?.user?.tenantId) {
      return this.request.user.tenantId;
    }

    // 2. TenantGuard-validated request property
    if (this.request?.tenantId) {
      return this.request.tenantId;
    }

    return null;
  }

  /**
   * Get tenant ID or throw error
   */
  private requireTenantId(): string {
    if (!this.tenantId) {
      throw new Error('Tenant context is required for this operation');
    }
    return this.tenantId;
  }

  /**
   * Find all entities for current tenant
   *
   * SECURITY: Always applies tenant filter to prevent cross-tenant data access.
   * The options.where clause is merged with tenant filter.
   */
  async find(options?: FindManyOptions<T>): Promise<T[]> {
    const tenantId = this.requireTenantId();

    // Merge tenant filter with provided where clause
    const mergedOptions: FindManyOptions<T> = {
      ...options,
      where: {
        ...((options?.where as Record<string, unknown>) || {}),
        tenantId,
      } as T extends ObjectLiteral ? T : never,
    };

    return this.repository.find(mergedOptions);
  }

  /**
   * Find one entity for current tenant
   *
   * SECURITY: Always applies tenant filter to prevent cross-tenant data access.
   * The options.where clause is merged with tenant filter.
   */
  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    const tenantId = this.requireTenantId();

    // Merge tenant filter with provided where clause
    const mergedOptions: FindOneOptions<T> = {
      ...options,
      where: {
        ...((options?.where as Record<string, unknown>) || {}),
        tenantId,
      } as T extends ObjectLiteral ? T : never,
    };

    return this.repository.findOne(mergedOptions);
  }

  /**
   * Find by ID with tenant filter
   */
  async findById(id: string): Promise<T | null> {
    const tenantId = this.requireTenantId();

    return this.repository
      .createQueryBuilder('entity')
      .where('entity.id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .getOne();
  }

  /**
   * Create entity with tenant ID
   */
  async create(entity: DeepPartial<T>): Promise<T> {
    const tenantId = this.requireTenantId();

    const entityWithTenant = {
      ...entity,
      tenantId,
    } as DeepPartial<T>;

    const created = this.repository.create(entityWithTenant);
    return this.repository.save(created);
  }

  /**
   * Create multiple entities with tenant ID
   */
  async createMany(entities: DeepPartial<T>[]): Promise<T[]> {
    const tenantId = this.requireTenantId();

    const entitiesWithTenant = entities.map((e) => ({
      ...e,
      tenantId,
    })) as DeepPartial<T>[];

    const created = this.repository.create(entitiesWithTenant);
    return this.repository.save(created);
  }

  /**
   * Update entity with tenant filter
   */
  async update(id: string, updates: DeepPartial<T>): Promise<T | null> {
    const tenantId = this.requireTenantId();

    // Ensure entity belongs to tenant
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    // Prevent changing tenant ID - strip it from the update payload
    const updateData = { ...updates } as Record<string, unknown>;
    delete updateData['tenantId'];

    await this.repository
      .createQueryBuilder()
      .update()
      .set(updateData as DeepPartial<T>)
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .execute();

    return this.findById(id);
  }

  /**
   * Delete entity with tenant filter
   */
  async delete(id: string): Promise<boolean> {
    const tenantId = this.requireTenantId();

    // Ensure entity belongs to tenant
    const existing = await this.findById(id);
    if (!existing) {
      return false;
    }

    await this.repository
      .createQueryBuilder()
      .delete()
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .execute();

    return true;
  }

  /**
   * Soft delete entity with tenant filter
   */
  async softDelete(id: string): Promise<boolean> {
    const tenantId = this.requireTenantId();

    const existing = await this.findById(id);
    if (!existing) {
      return false;
    }

    await this.repository
      .createQueryBuilder()
      .softDelete()
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .execute();

    return true;
  }

  /**
   * Count entities for current tenant
   */
  async count(): Promise<number> {
    const tenantId = this.requireTenantId();

    return this.repository
      .createQueryBuilder('entity')
      .where('"tenantId" = :tenantId', { tenantId })
      .getCount();
  }

  /**
   * Check if entity exists for current tenant
   */
  async exists(id: string): Promise<boolean> {
    const entity = await this.findById(id);
    return entity !== null;
  }

  /**
   * @deprecated Use getScopedRepository() for tenant-filtered access or
   * getUnfilteredRepository() for legitimate cross-tenant operations.
   *
   * This method is deprecated because it returns a raw repository without
   * automatic tenant filtering, which creates a risk of cross-tenant data leakage.
   *
   * @throws Error always - migrate to getScopedRepository() or getUnfilteredRepository()
   */
  getRepository(): never {
    throw new Error(
      'getRepository() is deprecated and unsafe. ' +
        'Use getScopedRepository() for automatic tenant filtering, or ' +
        'getUnfilteredRepository() for legitimate cross-tenant operations (e.g., admin, migrations).',
    );
  }

  /**
   * Get a scoped repository proxy that automatically applies tenant filtering
   * on find, findOne, count, and createQueryBuilder operations.
   *
   * SECURITY: All read operations automatically include tenantId filter.
   * This is the recommended way to access the repository for tenant-scoped work.
   */
  getScopedRepository(): ScopedRepository<T> {
    const tenantId = this.requireTenantId();
    const repository = this.repository;

    return {
      find(options?: FindManyOptions<T>): Promise<T[]> {
        const mergedOptions: FindManyOptions<T> = {
          ...options,
          where: {
            ...((options?.where as Record<string, unknown>) || {}),
            tenantId,
          } as FindOptionsWhere<T>,
        };
        return repository.find(mergedOptions);
      },

      findOne(options: FindOneOptions<T>): Promise<T | null> {
        const mergedOptions: FindOneOptions<T> = {
          ...options,
          where: {
            ...((options?.where as Record<string, unknown>) || {}),
            tenantId,
          } as FindOptionsWhere<T>,
        };
        return repository.findOne(mergedOptions);
      },

      count(options?: FindManyOptions<T>): Promise<number> {
        const mergedOptions: FindManyOptions<T> = {
          ...options,
          where: {
            ...((options?.where as Record<string, unknown>) || {}),
            tenantId,
          } as FindOptionsWhere<T>,
        };
        return repository.count(mergedOptions);
      },

      createQueryBuilder(alias?: string): SelectQueryBuilder<T> {
        const qb = repository.createQueryBuilder(alias);
        qb.andWhere('"tenantId" = :tenantId', { tenantId });
        return qb;
      },
    };
  }

  /**
   * Get the underlying repository WITHOUT tenant filtering.
   *
   * WARNING: Only use for legitimate cross-tenant operations such as:
   * - Admin/superuser queries
   * - System migrations
   * - Background jobs that span tenants
   *
   * Callers MUST manually apply tenant filtering where needed.
   */
  getUnfilteredRepository(): Repository<T> {
    return this.repository;
  }

  /**
   * Get current tenant ID
   */
  getTenantId(): string | null {
    return this.tenantId;
  }

  /**
   * Get tenant schema name
   */
  getSchemaName(): string | null {
    return this.schemaName;
  }

  /**
   * Execute raw query with tenant filter
   *
   * SECURITY: Uses a transaction to pin the connection and set search_path
   * with SET LOCAL (transaction-scoped), preventing cross-tenant data leakage
   * in connection pools. The schema name is validated through
   * getTenantSchemaName() which ensures UUID format.
   */
  async executeRaw<R = unknown>(query: string, parameters?: unknown[]): Promise<R> {
    const tenantId = this.requireTenantId();

    // SECURITY: Validate schema name format before using in query
    // Schema name comes from getTenantSchemaName() which validates UUID format
    // Additional validation ensures only safe characters (tenant_ + 16 hex chars)
    if (this.schemaName && !/^tenant_[a-f0-9]{16}$/.test(this.schemaName)) {
      throw new Error(`SECURITY: Invalid schema name format: ${this.schemaName}`);
    }

    // SECURITY: Use a transaction to pin the connection and set search_path
    // with SET LOCAL. This prevents the connection-pool race condition where
    // a concurrent coroutine could observe the wrong search_path.
    if (this.schemaName) {
      return this.dataSource.transaction(async (manager) => {
        // SET LOCAL via set_config with 'true' (is_local) - transaction-scoped
        await this.schemaManager.setTenantSearchPathInTransaction(manager, tenantId);
        return manager.query(query, parameters);
      });
    }

    return this.dataSource.query(query, parameters);
  }
}

/**
 * Create a tenant-aware repository for a specific entity
 */
export function createTenantAwareRepository<T extends TenantEntity>(
  dataSource: DataSource,
  schemaManager: SchemaManagerService,
  request: TenantRequest,
  entity: EntityTarget<T>,
): TenantAwareRepository<T> {
  return new TenantAwareRepository<T>(dataSource, schemaManager, request, entity);
}
