import { Repository, EntityTarget, DataSource, ObjectLiteral, DeepPartial, FindManyOptions, FindOneOptions } from 'typeorm';
import { Injectable, Scope, Inject, Logger } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { SchemaManagerService } from './schema-manager.service';

/**
 * Extended Request interface with tenant context
 */
interface TenantRequest extends Request {
  tenantId?: string;
  user?: {
    tenantId?: string;
    sub?: string;
    role?: string;
  };
}

/**
 * Base entity interface with tenantId
 */
export interface TenantEntity extends ObjectLiteral {
  tenantId: string;
}

/**
 * Tenant-Aware Repository Factory
 * Creates repositories that automatically filter by tenant and use tenant-specific schemas
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

    // Create repository (will be used with tenant filtering)
    this.repository = this.dataSource.getRepository(entity);
  }

  private extractTenantId(): string | null {
    // Try from user context (JWT)
    if (this.request?.user?.tenantId) {
      return this.request.user.tenantId;
    }

    // Try from request property
    if (this.request?.tenantId) {
      return this.request.tenantId;
    }

    // Try from headers
    const headerTenantId = this.request?.headers?.['x-tenant-id'];
    if (headerTenantId) {
      const tenantId = Array.isArray(headerTenantId) ? headerTenantId[0] : headerTenantId;
      return tenantId || null;
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
   */
  async find(options?: FindManyOptions<T>): Promise<T[]> {
    const tenantId = this.requireTenantId();

    return this.repository
      .createQueryBuilder('entity')
      .where('"tenantId" = :tenantId', { tenantId })
      .getMany();
  }

  /**
   * Find one entity for current tenant
   */
  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    const tenantId = this.requireTenantId();

    return this.repository
      .createQueryBuilder('entity')
      .where('"tenantId" = :tenantId', { tenantId })
      .getOne();
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

    const entitiesWithTenant = entities.map(e => ({
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

    // Prevent changing tenant ID
    const { tenantId: _, ...safeUpdates } = updates as Record<string, unknown>;

    await this.repository
      .createQueryBuilder()
      .update()
      .set(safeUpdates as any)
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
   * Get the underlying repository for advanced queries
   * NOTE: Use with caution - ensure tenant filtering is applied manually
   */
  getRepository(): Repository<T> {
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
   */
  async executeRaw<R = unknown>(
    query: string,
    parameters?: unknown[],
  ): Promise<R> {
    this.requireTenantId();

    // Set search_path for tenant isolation
    if (this.schemaName) {
      await this.dataSource.query(`SET search_path TO "${this.schemaName}", public`);
    }

    try {
      return await this.dataSource.query(query, parameters);
    } finally {
      // Reset search_path
      await this.dataSource.query(`SET search_path TO public`);
    }
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
