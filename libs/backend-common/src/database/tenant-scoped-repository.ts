import { Logger } from '@nestjs/common';
import {
  Repository,
  EntityTarget,
  DataSource,
  EntityManager,
  ObjectLiteral,
  DeepPartial,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  SelectQueryBuilder,
  UpdateResult,
  DeleteResult,
} from 'typeorm';

import { getRequestContext } from '../logging/request-context';

import { TenantEntity } from './tenant-entity.interface';
import { resolveTenantRepositoryFoundation } from './tenant-repository-foundation';

export type TenantScopedSelectQueryBuilder<T extends ObjectLiteral> = Omit<
  SelectQueryBuilder<T>,
  'where' | 'orWhere'
>;

/**
 * TenantScopedRepository<T> — wraps TypeORM Repository with mandatory tenant isolation.
 *
 * Every query method automatically injects tenantId into WHERE clauses.
 * There is NO way to execute a query without tenant scoping through this interface.
 *
 * For admin/cross-tenant operations, use BypassRlsService or a separate unscoped
 * repository with explicit @AdminOnly() guard.
 *
 * # Tenant ID resolution order:
 *   1. Explicit tenantId passed to the factory (for MQTT handlers, cron jobs, NATS)
 *   2. AsyncLocalStorage RequestContext (set by RequestContextMiddleware for HTTP,
 *      or by withTenantContext() for non-HTTP paths)
 *
 * This dual resolution means the same repository class works in ALL execution
 * contexts without any code changes at the call site.
 *
 * # Why this exists alongside TenantAwareRepository:
 *
 * TenantAwareRepository is REQUEST-scoped (@Inject(REQUEST)) so it only works for
 * HTTP handlers. MQTT listeners, NATS event handlers, and cron jobs have no Express
 * Request object. TenantScopedRepository reads from AsyncLocalStorage instead, which
 * is set by both HTTP middleware and withTenantContext().
 *
 * TenantAwareRepository.getScopedRepository() only exposes find/findOne/count/
 * createQueryBuilder — it's missing save/update/delete, which is the root cause
 * of ~30 findings where developers used raw repository.delete() without tenantId.
 *
 * @example
 * ```typescript
 * // HTTP handler — tenantId comes from RequestContextMiddleware → AsyncLocalStorage
 * constructor(
 *   @InjectTenantRepository(SensorDataChannel)
 *   private readonly channelRepo: TenantScopedRepository<SensorDataChannel>,
 * ) {}
 *
 * async deleteSensor(sensorId: string): Promise<void> {
 *   // tenantId is auto-injected — cross-tenant delete is structurally impossible
 *   await this.channelRepo.delete({ sensorId });
 * }
 *
 * // MQTT handler — tenantId comes from withTenantContext() → AsyncLocalStorage
 * await withTenantContext(msg.tenantId, async () => {
 *   await this.channelRepo.save(sensorReading);
 * });
 *
 * // Explicit tenantId (rare — for worker bootstrap)
 * const repo = TenantScopedRepository.create(dataSource, SensorDataChannel, tenantId);
 * await repo.delete({ sensorId });
 * ```
 */
export class TenantScopedRepository<T extends TenantEntity> {
  private readonly logger = new Logger(TenantScopedRepository.name);

  /**
   * @param repository - TypeORM repository for the target entity
   * @param explicitTenantId - Optional explicit tenantId (for MQTT/cron factory pattern).
   *   When provided, this takes precedence over AsyncLocalStorage.
   */
  private constructor(
    private readonly repository: Repository<T>,
    private readonly explicitTenantId?: string,
  ) {}

  // ── Static Factories ──

  /**
   * Create a TenantScopedRepository from a DataSource and entity class.
   *
   * @param dataSource - TypeORM DataSource instance
   * @param entity - Entity class (e.g. SensorDataChannel)
   * @param explicitTenantId - Optional explicit tenantId. When omitted, tenantId
   *   is resolved from AsyncLocalStorage at call time (preferred for HTTP handlers).
   * @returns A new TenantScopedRepository instance
   */
  static create<E extends TenantEntity>(
    dataSource: DataSource,
    entity: EntityTarget<E>,
    explicitTenantId?: string,
  ): TenantScopedRepository<E> {
    const repository = resolveTenantRepositoryFoundation(dataSource, entity);
    return TenantScopedRepository.fromRepository(repository, explicitTenantId);
  }

  /**
   * Create a TenantScopedRepository from an existing TypeORM Repository.
   *
   * @param repository - TypeORM Repository instance
   * @param explicitTenantId - Optional explicit tenantId
   * @returns A new TenantScopedRepository instance
   */
  static fromRepository<E extends TenantEntity>(
    repository: Repository<E>,
    explicitTenantId?: string,
  ): TenantScopedRepository<E> {
    return new TenantScopedRepository<E>(repository, explicitTenantId);
  }

  // ── Tenant ID Resolution ──

  /**
   * Resolve the current tenant ID from the explicit value or AsyncLocalStorage.
   *
   * SECURITY: This is the single enforcement point. Every public method calls
   * this and will throw if no tenant context exists. There is no fallback to
   * "run without tenant" — that would defeat the purpose of this class.
   *
   * @throws Error if no tenant context is available from any source
   */
  private requireTenantId(): string {
    // 1. Explicit tenantId (factory pattern for MQTT/cron)
    if (this.explicitTenantId) {
      return this.explicitTenantId;
    }

    // 2. AsyncLocalStorage (HTTP middleware or withTenantContext)
    const context = getRequestContext();
    if (context.tenantId) {
      return context.tenantId;
    }

    throw new Error(
      'SECURITY: No tenant context available. ' +
        'TenantScopedRepository requires a tenant ID from either: ' +
        '(1) explicit factory parameter, ' +
        '(2) AsyncLocalStorage via RequestContextMiddleware (HTTP) or withTenantContext() (MQTT/cron). ' +
        'This is a structural guard against cross-tenant data leaks.',
    );
  }

  /**
   * Get the current tenant ID (resolved, not null).
   * Useful for logging and debugging.
   *
   * @throws Error if no tenant context is available
   */
  getTenantId(): string {
    return this.requireTenantId();
  }

  // ── Read Operations ──

  /**
   * Find all entities for the current tenant.
   *
   * SECURITY: Always merges tenantId into the WHERE clause. The caller's
   * where conditions are preserved and AND-ed with the tenant filter.
   *
   * @param options - TypeORM FindManyOptions (where, order, take, skip, relations, etc.)
   * @returns Array of entities belonging to the current tenant
   */
  async find(options?: FindManyOptions<T>): Promise<T[]> {
    const tenantId = this.requireTenantId();
    return this.repository.find(this.mergeWhereMany(options, tenantId));
  }

  /**
   * Find one entity for the current tenant.
   *
   * SECURITY: Always merges tenantId into the WHERE clause.
   *
   * @param options - TypeORM FindOneOptions (where is required by TypeORM 0.3.x)
   * @returns The entity or null if not found within the tenant scope
   */
  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    const tenantId = this.requireTenantId();
    return this.repository.findOne(this.mergeWhereOne(options, tenantId));
  }

  /**
   * Find one entity or throw if not found within the tenant scope.
   *
   * @param options - TypeORM FindOneOptions
   * @returns The entity
   * @throws Error if entity not found in the current tenant
   */
  async findOneOrFail(options: FindOneOptions<T>): Promise<T> {
    const result = await this.findOne(options);
    if (!result) {
      throw new Error(
        'Entity not found within tenant scope ' + `(tenantId: ${this.requireTenantId()})`,
      );
    }
    return result;
  }

  /**
   * Find entity by ID within the current tenant.
   *
   * @param id - Entity primary key
   * @returns The entity or null
   */
  async findById(id: string): Promise<T | null> {
    const tenantId = this.requireTenantId();
    return this.repository
      .createQueryBuilder('entity')
      .where('entity.id = :id', { id })
      .andWhere('entity."tenantId" = :tenantId', { tenantId })
      .getOne();
  }

  /**
   * Count entities for the current tenant.
   *
   * SECURITY: Always merges tenantId into the WHERE clause.
   *
   * @param options - Optional TypeORM FindManyOptions for additional filtering
   * @returns Count of matching entities within the tenant scope
   */
  async count(options?: FindManyOptions<T>): Promise<number> {
    const tenantId = this.requireTenantId();
    return this.repository.count(this.mergeWhereMany(options, tenantId));
  }

  /**
   * Check if an entity exists within the current tenant.
   *
   * @param id - Entity primary key
   * @returns true if the entity exists and belongs to the current tenant
   */
  async exists(id: string): Promise<boolean> {
    const entity = await this.findById(id);
    return entity !== null;
  }

  // ── Write Operations ──

  /**
   * Save (insert or update) an entity with tenant ID enforcement.
   *
   * SECURITY: Always sets entity.tenantId to the current tenant. If the entity
   * already has a different tenantId, it is OVERWRITTEN — a tenant-scoped
   * repository must never persist an entity with a foreign tenantId.
   *
   * @param entity - Entity or partial entity to save
   * @returns The saved entity with all DB-generated fields populated
   */
  async save(entity: DeepPartial<T>): Promise<T> {
    const tenantId = this.requireTenantId();
    const entityWithTenant = {
      ...entity,
      tenantId,
    } as DeepPartial<T>;

    const created = this.repository.create(entityWithTenant);
    return this.repository.save(created);
  }

  /**
   * Construct an in-memory entity instance (no persistence) with tenantId
   * auto-populated from the current tenant context.
   *
   * Mirrors TypeORM `Repository.create(dto)` but guarantees the returned
   * entity carries the correct tenantId, so subsequent `.save()` through
   * THIS repository (or the underlying DataSource) cannot accidentally
   * land under a different tenant.
   *
   * @param dto - Partial entity shape
   * @returns A new unsaved entity instance with tenantId injected
   */
  create(dto: DeepPartial<T>): T {
    const tenantId = this.requireTenantId();
    return this.repository.create({ ...dto, tenantId } as DeepPartial<T>);
  }

  /**
   * Delete an entity that was previously loaded from THIS repository.
   * Verifies `entity.tenantId` matches the current tenant context
   * before issuing the DELETE — protects against a caller passing an
   * entity loaded via a different (or unscoped) path.
   *
   * @param entity - Entity instance to remove
   * @returns The removed entity (same shape as TypeORM Repository.remove)
   */
  async remove(entity: T): Promise<T> {
    const tenantId = this.requireTenantId();
    if ((entity as { tenantId?: string }).tenantId !== tenantId) {
      throw new Error(
        `TenantScopedRepository.remove: entity.tenantId (${(entity as { tenantId?: string }).tenantId}) ` +
          `!= current tenant (${tenantId}). Refusing to remove cross-tenant entity.`,
      );
    }
    return this.repository.remove(entity);
  }

  /**
   * Save multiple entities with tenant ID enforcement.
   *
   * SECURITY: Every entity gets tenantId forced to the current tenant.
   *
   * @param entities - Array of entities or partial entities
   * @returns Array of saved entities
   */
  async saveMany(entities: DeepPartial<T>[]): Promise<T[]> {
    const tenantId = this.requireTenantId();
    const withTenant = entities.map((e) => ({
      ...e,
      tenantId,
    })) as DeepPartial<T>[];

    const created = this.repository.create(withTenant);
    return this.repository.save(created);
  }

  /**
   * Update entities matching criteria within the current tenant.
   *
   * SECURITY: tenantId is always AND-ed into the criteria. Even if the caller
   * passes `{ sensorId: 'x' }`, the actual WHERE becomes
   * `WHERE sensorId = 'x' AND tenantId = :tenantId`.
   *
   * The tenantId field is stripped from the partial entity to prevent
   * reassignment of entities to a different tenant.
   *
   * @param criteria - WHERE conditions (tenantId is auto-added)
   * @param partialEntity - Fields to update
   * @returns TypeORM UpdateResult with affected row count
   */
  async update(
    criteria: FindOptionsWhere<T>,
    partialEntity: DeepPartial<T>,
  ): Promise<UpdateResult> {
    const tenantId = this.requireTenantId();

    // SECURITY: Strip tenantId from the update payload to prevent tenant reassignment
    const safeUpdate = { ...partialEntity } as Record<string, unknown>;
    delete safeUpdate['tenantId'];

    const scopedCriteria = {
      ...criteria,
      tenantId,
    } as FindOptionsWhere<T>;

    return this.repository.update(scopedCriteria, safeUpdate as DeepPartial<T>);
  }

  /**
   * Delete entities matching criteria within the current tenant.
   *
   * SECURITY: This is the ROOT CAUSE fix for SENSOR-CRITICAL-002 and similar findings.
   * tenantId is always AND-ed into the criteria. A call like:
   *   `repo.delete({ sensorId: 'x' })`
   * becomes:
   *   `DELETE ... WHERE sensorId = 'x' AND tenantId = :tenantId`
   *
   * It is STRUCTURALLY IMPOSSIBLE to delete another tenant's data through this method.
   *
   * @param criteria - WHERE conditions (tenantId is auto-added)
   * @returns TypeORM DeleteResult with affected row count
   */
  async delete(criteria: FindOptionsWhere<T>): Promise<DeleteResult> {
    const tenantId = this.requireTenantId();

    const scopedCriteria = {
      ...criteria,
      tenantId,
    } as FindOptionsWhere<T>;

    return this.repository.delete(scopedCriteria);
  }

  /**
   * Soft-delete entities matching criteria within the current tenant.
   *
   * SECURITY: Same tenant scoping as delete(). Sets the deletedAt column
   * instead of physically removing the row.
   *
   * @param criteria - WHERE conditions (tenantId is auto-added)
   * @returns TypeORM UpdateResult with affected row count
   */
  async softDelete(criteria: FindOptionsWhere<T>): Promise<UpdateResult> {
    const tenantId = this.requireTenantId();

    const scopedCriteria = {
      ...criteria,
      tenantId,
    } as FindOptionsWhere<T>;

    return this.repository.softDelete(scopedCriteria);
  }

  // ── Query Builder ──

  /**
   * Create a query builder with automatic tenant scoping.
   *
   * SECURITY: Immediately adds `.where('alias.tenantId = :tenantId', { tenantId })`
   * to the query builder, then removes `.where()` / `.orWhere()` from the
   * exposed API. Callers can only narrow the result set with `.andWhere()`.
   *
   * @param alias - Table alias for the query builder (default: 'entity')
   * @returns SelectQueryBuilder with tenant filter pre-applied and unsafe predicate resetters hidden
   */
  createQueryBuilder(alias = 'entity'): TenantScopedSelectQueryBuilder<T> {
    const tenantId = this.requireTenantId();
    const qb = this.repository.createQueryBuilder(alias);
    const tenantColumn = this.getTenantColumnName();
    qb.where(`${alias}."${tenantColumn}" = :tenantId`, { tenantId });
    this.disablePredicateResetters(qb);
    return qb;
  }

  // ── Private Helpers ──

  /**
   * Merge tenantId into FindManyOptions.where clause.
   *
   * Handles both undefined options and existing where conditions.
   * Uses object spread so the caller's conditions are preserved.
   */
  private mergeWhereMany(
    options: FindManyOptions<T> | undefined,
    tenantId: string,
  ): FindManyOptions<T> {
    return {
      ...options,
      where: this.mergeWhereClause(options?.where, tenantId),
    };
  }

  /**
   * Merge tenantId into FindOneOptions.where clause.
   */
  private mergeWhereOne(options: FindOneOptions<T>, tenantId: string): FindOneOptions<T> {
    return {
      ...options,
      where: this.mergeWhereClause(options?.where, tenantId),
    };
  }

  private mergeWhereClause(
    where: FindOptionsWhere<T> | FindOptionsWhere<T>[] | undefined,
    tenantId: string,
  ): FindOptionsWhere<T> | FindOptionsWhere<T>[] {
    if (Array.isArray(where)) {
      return where.map((clause) => ({
        ...(clause as Record<string, unknown>),
        tenantId,
      })) as FindOptionsWhere<T>[];
    }

    return {
      ...((where as Record<string, unknown> | undefined) || {}),
      tenantId,
    } as FindOptionsWhere<T>;
  }

  private disablePredicateResetters(qb: SelectQueryBuilder<T>): void {
    const rejectPredicateReset = (): never => {
      throw new Error(
        'TenantScopedRepository query builders are already tenant-scoped. Use andWhere() to add predicates.',
      );
    };

    Object.defineProperty(qb, 'where', {
      value: rejectPredicateReset,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(qb, 'orWhere', {
      value: rejectPredicateReset,
      configurable: false,
      writable: false,
    });
  }

  private getTenantColumnName(): string {
    const columnName =
      this.repository.metadata.findColumnWithPropertyName('tenantId')?.databaseName ?? 'tenantId';

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)) {
      throw new Error(
        `TenantScopedRepository cannot build a safe tenant predicate for column ${columnName}`,
      );
    }

    return columnName;
  }
}

/**
 * `tenantManagerRepo(manager, Entity)` — the canonical way to obtain a
 * tenant-scoped repository inside a TypeORM transaction. Wraps
 * `manager.getRepository(Entity)` in a TenantScopedRepository so every
 * query auto-injects tenantId from AsyncLocalStorage.
 *
 * Without this helper, transaction-scoped code falls back to raw
 * `manager.getRepository(Entity)` + manual `{ where: { ..., tenantId } }`
 * — which the ESLint rule `no-restricted-syntax` rightly flags
 * (CLAUDE.md: "getRepository() is FORBIDDEN") and which frequently
 * leaks cross-tenant queries when a developer forgets the `tenantId`
 * key. The wrapper has a single, audited TypeORM primitive binding at the
 * library boundary — that binding
 * is architecturally justified because the return value is
 * immediately handed to TenantScopedRepository which enforces
 * tenant scoping on every downstream query.
 *
 * Usage pattern:
 * ```ts
 * await this.dataSource.transaction(async (manager) => {
 *   const inventoryRepo = tenantManagerRepo(manager, StorageInventory);
 *   const movementRepo = tenantManagerRepo(manager, StockMovement);
 *
 *   // Both queries below auto-include tenantId in the WHERE clause.
 *   const inventory = await inventoryRepo.findOne({ where: { id: inventoryId } });
 *   await movementRepo.save({ ... });
 * });
 * ```
 *
 * @param manager - TypeORM EntityManager (from `dataSource.transaction(m => ...)` or
 *   `queryRunner.manager`).
 * @param entity - The entity class to scope.
 * @param explicitTenantId - Optional override; falls back to
 *   AsyncLocalStorage via TenantScopedRepository.requireTenantId().
 */
export function tenantManagerRepo<T extends TenantEntity>(
  manager: EntityManager,
  entity: EntityTarget<T>,
  explicitTenantId?: string,
): TenantScopedRepository<T> {
  const repository = resolveTenantRepositoryFoundation(manager, entity);
  return TenantScopedRepository.fromRepository(repository, explicitTenantId);
}
