import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { ComplianceAuditLog, ComplianceAction } from '../entities/compliance-audit-log.entity';

/**
 * Parameters for creating an audit log entry.
 */
export interface AuditLogParams {
  tenantId: string;
  userId: string;
  action: ComplianceAction;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Filters for querying the compliance audit log.
 */
export interface AuditLogFilters {
  tenantId: string;
  userId?: string;
  action?: ComplianceAction;
  resourceType?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Cursor-paginated result for audit log entries.
 */
export interface AuditLogPage {
  items: ComplianceAuditLog[];
  hasMore: boolean;
  cursor: string | null;
  totalCount: number;
}

/**
 * Service responsible for logging all messaging operations
 * to the compliance audit log.
 *
 * Supports both individual and bulk inserts for performance.
 * All GraphQL mutations are automatically logged via the AuditLogInterceptor.
 *
 * @see ADR-012 Phase 3 (Compliance Audit Log)
 */
@Injectable()
export class ComplianceAuditService {
  private readonly logger = new Logger(ComplianceAuditService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Log a single audit entry.
   *
   * @param manager Optional EntityManager for transactional callers.
   *   BEFORE: log() always used its own injected auditRepo — writes were outside
   *   the caller's transaction. If ActivateLegalHoldHandler's transaction rolled back
   *   after audit.log() succeeded, the audit entry remained but the hold was gone
   *   (ghost audit entry for a non-existent hold).
   *   WHY: Passing manager ensures audit entry and hold state are committed atomically.
   *   When manager is provided, errors propagate to the transaction (no try/catch).
   *   When no manager (fire-and-forget callers), errors are caught as before.
   */
  async log(params: AuditLogParams, manager?: EntityManager): Promise<void> {
    // Inside-transaction path wraps via tenantManagerRepo so the audit row
    // can never carry a tenantId different from the caller's request scope.
    // Outside-transaction fallback (fire-and-forget) carries explicit
    // tenantId in the entry payload below.
    const writeEntry = async (entityManager: EntityManager): Promise<void> => {
      const repo = tenantManagerRepo(entityManager, ComplianceAuditLog, params.tenantId);
      const entry = repo.create({
        tenantId: params.tenantId,
        userId: params.userId,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        details: params.details,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });
      await repo.save(entry);
    };

    if (manager) {
      // Transactional caller: propagate errors so the transaction can roll back
      await writeEntry(manager);
    } else {
      // Fire-and-forget caller: catch errors to avoid disrupting the caller
      try {
        await runInTenantTransaction(this.dataSource, 'messaging', params.tenantId, (queryRunner) =>
          writeEntry(queryRunner.manager),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to write audit log: ${message}`);
      }
    }
  }

  /**
   * Bulk-insert multiple audit entries in a single operation.
   * Used by the interceptor to batch log entries per request.
   */
  async logBatch(entries: AuditLogParams[]): Promise<void> {
    if (entries.length === 0) return;

    try {
      const grouped = new Map<string, AuditLogParams[]>();
      for (const entry of entries) {
        const tenantEntries = grouped.get(entry.tenantId) ?? [];
        tenantEntries.push(entry);
        grouped.set(entry.tenantId, tenantEntries);
      }

      for (const [tenantId, tenantEntries] of grouped) {
        await runInTenantTransaction(
          this.dataSource,
          'messaging',
          tenantId,
          async (queryRunner) => {
            const repo = tenantManagerRepo(queryRunner.manager, ComplianceAuditLog, tenantId);
            await repo.saveMany(
              tenantEntries.map((params) => ({
                tenantId: params.tenantId,
                userId: params.userId,
                action: params.action,
                resourceType: params.resourceType,
                resourceId: params.resourceId,
                details: params.details,
                ipAddress: params.ipAddress,
                userAgent: params.userAgent,
              })),
            );
          },
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to write batch audit log (${entries.length} entries): ${message}`);
    }
  }

  /**
   * Query the audit log with cursor-based pagination and filters.
   * Only accessible to TENANT_ADMIN+.
   */
  async getAuditLog(
    filters: AuditLogFilters,
    limit: number,
    cursor: string | null,
  ): Promise<AuditLogPage> {
    return runInTenantTransaction(
      this.dataSource,
      'messaging',
      filters.tenantId,
      async (queryRunner) => {
        const repo = tenantManagerRepo(queryRunner.manager, ComplianceAuditLog, filters.tenantId);
        const qb = repo.createQueryBuilder('a');

        if (filters.userId) {
          qb.andWhere('a."userId" = :userId', { userId: filters.userId });
        }
        if (filters.action) {
          qb.andWhere('a."action" = :action', { action: filters.action });
        }
        if (filters.resourceType) {
          qb.andWhere('a."resourceType" = :resourceType', {
            resourceType: filters.resourceType,
          });
        }
        if (filters.startDate) {
          qb.andWhere('a."createdAt" >= :startDate', { startDate: filters.startDate });
        }
        if (filters.endDate) {
          qb.andWhere('a."createdAt" <= :endDate', { endDate: filters.endDate });
        }

        // Cursor-based pagination
        if (cursor) {
          const decoded = this.decodeCursor(cursor);
          qb.andWhere(
            '(a."createdAt" < :cursorDate OR (a."createdAt" = :cursorDate AND a."id" < :cursorId))',
            { cursorDate: decoded.createdAt, cursorId: decoded.id },
          );
        }

        qb.orderBy('a."createdAt"', 'DESC').addOrderBy('a."id"', 'DESC');
        qb.take(limit + 1);

        const [items, totalCount] = await Promise.all([
          qb.getMany(),
          repo.createQueryBuilder('a').getCount(),
        ]);

        const hasMore = items.length > limit;
        const page = hasMore ? items.slice(0, limit) : items;
        const nextCursor = hasMore ? this.encodeCursor(page[page.length - 1]!) : null;

        return { items: page, hasMore, cursor: nextCursor, totalCount };
      },
    );
  }

  private encodeCursor(entry: ComplianceAuditLog): string {
    const payload = {
      createdAt: entry.createdAt.toISOString(),
      id: entry.id,
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: string; id: string } {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    return JSON.parse(json) as { createdAt: string; id: string };
  }
}
