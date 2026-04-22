/**
 * RestoreService
 *
 * Generic soft-delete restore. Today at least eight farm-service
 * entities ship with a `softDelete()` / `restore()` method pair
 * (Feed, FeedTypeSpecies, Supplier, Species, SubSystem, System,
 * BatchFeedAssignment, Chemical, Consumable, TankOperation,
 * TankAllocation, …) but only three of them have a matching
 * GraphQL mutation, and each wires the read + mutate + audit-log
 * plumbing by hand — different tenant checks, different permission
 * assertions, no uniqueness pre-check.
 *
 * This service centralises the invariant:
 *
 *   1. Load the entity by id WITH `isDeleted: true` filter — trying
 *      to restore an entity that is not soft-deleted is a client
 *      bug and throws `BadRequestException`.
 *   2. Tenant check — the entity must belong to the caller's tenant
 *      otherwise we raise `NotFoundException` (not Forbidden — the
 *      row is hidden from the caller entirely so we do not leak its
 *      existence).
 *   3. Uniqueness pre-check — before flipping `isDeleted` back to
 *      false, ensure no OTHER active row violates a UNIQUE
 *      constraint on the same (tenant, key) tuple. Without this
 *      check a restored row can trip a database constraint at the
 *      next save (e.g. `batch_feed_assignments` has a per-batch
 *      active UNIQUE, so restoring an old assignment while a newer
 *      one is active fails). The caller lists the uniqueness keys
 *      via the `uniqueKeys` option.
 *   4. Call the entity's `restore()` method (which flips isDeleted,
 *      clears deletedAt/deletedBy, and re-activates the row).
 *   5. Persist and emit an audit log entry via AuditLogService
 *      `logRestore()`.
 *
 * Phase 4.2 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 6.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityTarget, FindOptionsWhere, Repository } from 'typeorm';

import { AuditLogService } from '../../database/services/audit-log.service';

/** Minimum contract a restorable entity must satisfy. */
export interface RestorableEntity {
  id: string;
  tenantId: string;
  isDeleted: boolean;
  isActive?: boolean;
  restore(): void;
}

export interface RestoreOptions<T extends RestorableEntity> {
  /**
   * Unique-key sets to check before flipping `isDeleted` back to
   * false. For each key set, the service runs an existence query for
   * an active row (`isDeleted: false`) matching the same values on
   * the restore target. If any active row exists, the restore is
   * rejected with `ConflictException` so the caller can ask the
   * user how to resolve it (rename, merge, etc.).
   *
   * Example — `batch_feed_assignments.batchId` is active-unique:
   *   uniqueKeys: [['batchId']]
   */
  uniqueKeys?: Array<Array<keyof T & string>>;
  /**
   * Extra where clauses to OR into the uniqueness check — rarely
   * needed, lets an entity exclude itself from the conflict search
   * by a non-equality condition.
   */
  extraUniquenessFilter?: Record<string, unknown>;
  /**
   * Entity-type label written to the audit log. Defaults to the
   * entity constructor's name.
   */
  auditEntityType?: string;
}

export interface RestoreContext {
  tenantId: string;
  userId: string;
  userName?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

@Injectable()
export class RestoreService {
  private readonly logger = new Logger(RestoreService.name);

  constructor(private readonly auditLogService: AuditLogService) {}

  async restore<T extends RestorableEntity>(
    repository: Repository<T>,
    entityTarget: EntityTarget<T>,
    id: string,
    context: RestoreContext,
    options: RestoreOptions<T> = {},
  ): Promise<T> {
    const entityTypeLabel =
      options.auditEntityType ??
      (typeof entityTarget === 'function'
        ? entityTarget.name
        : String(entityTarget));

    // Load WITH `isDeleted: true` — restoring an active row is a
    // client bug. `withDeleted` is required so TypeORM includes
    // soft-deleted rows; we further narrow by tenant to prevent
    // cross-tenant restores.
    const existing = await this.findSoftDeleted(repository, id, context.tenantId);
    if (!existing) {
      throw new NotFoundException(
        `${entityTypeLabel} ${id} not found among soft-deleted rows for this tenant.`,
      );
    }

    if (!existing.isDeleted) {
      throw new BadRequestException(
        `${entityTypeLabel} ${id} is not soft-deleted — nothing to restore.`,
      );
    }

    if (options.uniqueKeys?.length) {
      await this.assertUniqueness(
        repository,
        entityTypeLabel,
        existing,
        options.uniqueKeys,
        options.extraUniquenessFilter,
      );
    }

    existing.restore();
    const saved = await repository.save(existing);

    await this.auditLogService.logRestore(
      context.tenantId,
      entityTypeLabel,
      existing.id,
      this.toRecord(saved),
      context.userId,
      context.userName,
      {
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        source: 'API',
      },
    );

    this.logger.log(
      `Restored ${entityTypeLabel} ${existing.id} for tenant ${context.tenantId} by user ${context.userId}.`,
    );

    return saved;
  }

  private async findSoftDeleted<T extends RestorableEntity>(
    repository: Repository<T>,
    id: string,
    tenantId: string,
  ): Promise<T | null> {
    // We build the query manually so the `isDeleted = true` clause
    // is explicit. Most entities in this codebase do NOT use
    // TypeORM's `@DeleteDateColumn` — the soft-delete flag is a
    // plain boolean column — so `withDeleted()` is a no-op for us
    // and we rely on the filter.
    const where = {
      id,
      tenantId,
      isDeleted: true,
    } as unknown as FindOptionsWhere<T>;
    const results = await repository.find({ where, take: 1 });
    return results[0] ?? null;
  }

  private async assertUniqueness<T extends RestorableEntity>(
    repository: Repository<T>,
    entityTypeLabel: string,
    existing: T,
    uniqueKeys: Array<Array<keyof T & string>>,
    extraFilter?: Record<string, unknown>,
  ): Promise<void> {
    for (const keyset of uniqueKeys) {
      const filter: Record<string, unknown> = {
        tenantId: existing.tenantId,
        isDeleted: false,
      };
      for (const k of keyset) {
        filter[k] = existing[k];
      }
      if (extraFilter) {
        Object.assign(filter, extraFilter);
      }

      const conflict = await repository.findOne({
        where: filter as unknown as FindOptionsWhere<T>,
      });
      if (conflict) {
        throw new ConflictException(
          `Cannot restore ${entityTypeLabel} ${existing.id}: an active row already occupies the unique key (${keyset.join(', ')}). Deactivate or rename the conflicting row first.`,
        );
      }
    }
  }

  private toRecord(entity: unknown): Record<string, unknown> {
    if (entity && typeof entity === 'object') {
      return { ...(entity as Record<string, unknown>) };
    }
    return {};
  }
}
