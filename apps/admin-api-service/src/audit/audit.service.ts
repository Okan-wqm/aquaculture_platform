import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  auditStatisticsProjectionHasValidEvidenceV2,
  createAuditStatisticsScopeV2,
  type AuditStatisticsScopeV2,
} from '@aquaculture/shared-contracts';
import {
  ADMIN_AUDIT_WRITE_POLICY,
  ADMIN_AUDIT_TRUST_CLASS,
  adminAuditDefinition,
  type ActiveAdminAuditAction,
  type AdminAuditAction,
  type AdminAuditActionForPolicy,
  type AdminAuditWritePolicy,
} from '@platform/admin-http-contracts';
import {
  Repository,
  Between,
  EntityManager,
  FindOptionsWhere,
  MoreThanOrEqual,
  LessThanOrEqual,
  SelectQueryBuilder,
} from 'typeorm';

import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';

import { AuditLog } from './audit.entity';
import { ADMIN_AUDIT_APPEND_SQL } from './audit-database-authority';
import type { AuditSeverity, AuditStatisticsDto } from './dto/audit-log.dto';

export interface AuditLogInput<TAction extends ActiveAdminAuditAction = ActiveAdminAuditAction> {
  action: TAction;
  entityType: string;
  entityId?: string;
  tenantId?: string;
  performedBy: string;
  performedByEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  requestId?: string;
  sessionId?: string;
}

export type MandatoryTransactionalAuditInput = AuditLogInput<
  AdminAuditActionForPolicy<'MANDATORY_IN_TRANSACTION'>
>;

export type MandatoryDisclosureAuditInput = AuditLogInput<
  AdminAuditActionForPolicy<'MANDATORY_BEFORE_DISCLOSURE'>
>;

export type OptionalTelemetryAuditInput = AuditLogInput<
  AdminAuditActionForPolicy<'OPTIONAL_TELEMETRY'>
>;

export interface AuditLogFilter {
  action?: AdminAuditAction;
  entityType?: string;
  entityId?: string;
  tenantId?: string;
  performedBy?: string;
  performedByEmail?: string;
  severity?: AuditSeverity;
  startDate?: Date;
  endDate?: Date;
  search?: string;
}

interface AuditStatisticsAggregateRow {
  total_logs?: unknown;
  observed_logs?: unknown;
  legacy_unverified_logs?: unknown;
  last_24_hours?: unknown;
  by_action?: unknown;
  by_severity?: unknown;
  by_entity_type?: unknown;
  top_users?: unknown;
}

function parseAuditCount(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ServiceUnavailableException(`Audit statistics source returned invalid ${field}`);
  }
  return parsed;
}

function parseAuditArray(value: unknown, field: string): unknown[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new ServiceUnavailableException(`Audit statistics source returned malformed ${field}`);
    }
  }
  if (!Array.isArray(parsed)) {
    throw new ServiceUnavailableException(`Audit statistics source omitted ${field}`);
  }
  return parsed;
}

function parseAuditString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ServiceUnavailableException(`Audit statistics source returned invalid ${field}`);
  }
  return value;
}

function parseAuditRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServiceUnavailableException(`Audit statistics source returned invalid ${field}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  /**
   * Append a mandatory audit event and surface persistence failures to the
   * caller. Security-critical workflows use this boundary so state cannot be
   * reported as successful when its forensic record was dropped.
   */
  private async recordWithRepository<TAction extends ActiveAdminAuditAction>(
    repository: Repository<AuditLog>,
    input: AuditLogInput<TAction>,
    expectedPolicy: AdminAuditWritePolicy,
  ): Promise<AuditLog> {
    const definition = adminAuditDefinition(input.action);
    if (definition.lifecycle !== 'ACTIVE' || definition.writePolicy !== expectedPolicy) {
      throw new TypeError(
        `Audit action ${input.action} requires ${String(definition.writePolicy)}, not ${expectedPolicy}`,
      );
    }
    const rows = await repository.manager.query<AuditLog[]>(ADMIN_AUDIT_APPEND_SQL, [
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.tenantId ?? null,
      input.performedBy,
      input.performedByEmail ?? null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      input.details ?? null,
      input.previousValue ?? null,
      input.newValue ?? null,
      definition.severity,
      input.requestId ?? null,
      input.sessionId ?? null,
    ]);
    const receipt = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
    if (
      receipt === undefined ||
      receipt.action !== input.action ||
      receipt.trustClass !== ADMIN_AUDIT_TRUST_CLASS.AUTHORITATIVE_RUNTIME ||
      receipt.provenance != null
    ) {
      throw new ServiceUnavailableException(
        'Canonical admin audit append authority returned an invalid receipt',
      );
    }
    const savedLog = repository.create(receipt);

    this.logger.debug(`Audit log created: ${input.action} by ${input.performedBy}`);

    return savedLog;
  }

  /**
   * Append through the caller's EntityManager so a security state transition
   * and its audit row commit or roll back as one PostgreSQL transaction.
   */
  async appendInTransaction(
    entityManager: EntityManager,
    input: MandatoryTransactionalAuditInput,
  ): Promise<AuditLog> {
    return this.recordWithRepository(
      entityManager.withRepository(this.auditLogRepository),
      input,
      ADMIN_AUDIT_WRITE_POLICY.MANDATORY_IN_TRANSACTION,
    );
  }

  /**
   * Append evidence before returning sensitive data to the caller.
   */
  async appendBeforeDisclosure(input: MandatoryDisclosureAuditInput): Promise<AuditLog> {
    return this.recordWithRepository(
      this.auditLogRepository,
      input,
      ADMIN_AUDIT_WRITE_POLICY.MANDATORY_BEFORE_DISCLOSURE,
    );
  }

  /** Best-effort is deliberately unrepresentable outside telemetry actions. */
  async appendOptionalTelemetry(input: OptionalTelemetryAuditInput): Promise<AuditLog | null> {
    try {
      return await this.recordWithRepository(
        this.auditLogRepository,
        input,
        ADMIN_AUDIT_WRITE_POLICY.OPTIONAL_TELEMETRY,
      );
    } catch (error) {
      // BUG-029 fix: return null instead of an unsaved entity that callers
      // may mistakenly treat as persisted (e.g., checking .id for existence).
      // Don't throw - audit logging should not break main operations.
      this.logger.error(
        `Failed to create audit log: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return null;
    }
  }

  /**
   * Query audit logs with filtering and pagination
   */
  async query(
    filter: AuditLogFilter,
    page = 1,
    limit = 50,
  ): Promise<IStandardPaginatedResult<AuditLog>> {
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const queryBuilder = this.filteredQuery(filter).orderBy('audit.createdAt', 'DESC');

    queryBuilder.skip(skip).take(take);

    const [data, total] = await queryBuilder.getManyAndCount();

    return createStandardPaginatedResult(data, total, page, take);
  }

  /**
   * Bounded canonical export projection. Unlike page queries this does not
   * silently clamp to 100 rows; the route owns the explicit artifact budget.
   */
  async getExportRows(filter: AuditLogFilter, limit = 100_000): Promise<AuditLog[]> {
    return this.filteredQuery(filter).orderBy('audit.createdAt', 'ASC').take(limit).getMany();
  }

  private filteredQuery(filter: AuditLogFilter): SelectQueryBuilder<AuditLog> {
    const queryBuilder = this.auditLogRepository.createQueryBuilder('audit');

    if (filter.action) {
      queryBuilder.andWhere('audit.action = :action', { action: filter.action });
    }

    if (filter.entityType) {
      queryBuilder.andWhere('audit.entityType = :entityType', {
        entityType: filter.entityType,
      });
    }

    if (filter.entityId) {
      queryBuilder.andWhere('audit.entityId = :entityId', {
        entityId: filter.entityId,
      });
    }

    if (filter.tenantId) {
      queryBuilder.andWhere('audit.tenantId = :tenantId', {
        tenantId: filter.tenantId,
      });
    }

    if (filter.performedBy) {
      queryBuilder.andWhere('audit.performedBy = :performedBy', {
        performedBy: filter.performedBy,
      });
    }

    if (filter.performedByEmail) {
      queryBuilder.andWhere('audit.performedByEmail = :performedByEmail', {
        performedByEmail: filter.performedByEmail,
      });
    }

    if (filter.severity) {
      queryBuilder.andWhere('audit.severity = :severity', {
        severity: filter.severity,
      });
    }

    if (filter.startDate) {
      queryBuilder.andWhere('audit.createdAt >= :startDate', {
        startDate: filter.startDate,
      });
    }

    if (filter.endDate) {
      queryBuilder.andWhere('audit.createdAt <= :endDate', {
        endDate: filter.endDate,
      });
    }

    if (filter.search) {
      // MED-006 fix: restrict search to safe, non-sensitive indexed fields only.
      // Casting details::text was allowing substring matches against JSONB blobs that
      // may contain PII, API keys, or other sensitive data stored in audit entries.
      queryBuilder.andWhere(
        '(audit.action ILIKE :search OR audit.entityType ILIKE :search OR audit.entityId ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    return queryBuilder;
  }

  /**
   * Get audit logs for a specific entity
   */
  async getEntityHistory(entityType: string, entityId: string, limit = 100): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { entityType, entityId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get audit logs for a specific user's actions
   */
  async getUserActivity(
    userId: string,
    startDate?: Date,
    endDate?: Date,
    limit = 100,
  ): Promise<AuditLog[]> {
    const where: FindOptionsWhere<AuditLog> = { performedBy: userId };

    if (startDate && endDate) {
      where.createdAt = Between(startDate, endDate);
    } else if (startDate) {
      where.createdAt = MoreThanOrEqual(startDate);
    } else if (endDate) {
      where.createdAt = LessThanOrEqual(endDate);
    }

    return this.auditLogRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get security-related audit logs.
   *
   * # Cross-tenant semantics
   *
   * When `tenantId` is supplied, the query is scoped to that tenant.
   * When omitted, the call returns security events platform-wide across
   * EVERY tenant. Cross-tenant read is intentional for SUPER_ADMIN
   * platform-level security dashboards, and is safe here because:
   *
   *   1. Access is gated by `PlatformAdminGuard` at the global APP_GUARD
   *      level (apps/admin-api-service/src/app.module.ts:254-263) — every
   *      endpoint in admin-api-service requires SUPER_ADMIN role.
   *
   *   2. `AdminBypassRlsInterceptor` wraps every admin-api request in
   *      `BypassRlsService.withBypass()`, which sets `app.bypass_rls = 'on'`
   *      on the connection. RLS policy lets the query see cross-tenant
   *      rows only under this explicit bypass — which is audit-logged
   *      (WARN level, `RLS BYPASS GRANTED`) for compliance review.
   *
   *   3. The caller (audit.controller.ts) also writes a meta-audit entry
   *      via `writeMetaAudit()` so there's a second trail recording
   *      "admin X queried audit logs at time T with filter F".
   *
   * If a caller wants EXPLICIT platform-wide semantics to avoid the
   * "tenantId accidentally undefined" footgun, pass `null` or `undefined`
   * deliberately — the meta-audit entry records the absence.
   */
  async getSecurityLogs(tenantId?: string, limit = 100): Promise<AuditLog[]> {
    const securityActions = [
      'LOGIN_SUCCESS',
      'LOGIN_FAILED',
      'LOGOUT',
      'TOKEN_REVOKED',
      'PERMISSION_DENIED',
      'SUSPICIOUS_ACTIVITY',
      'USER_PASSWORD_RESET',
      'USER_LOCKED',
      'USER_UNLOCKED',
      'USER_IMPERSONATED',
    ];

    const queryBuilder = this.auditLogRepository
      .createQueryBuilder('audit')
      .where('audit.action IN (:...actions)', { actions: securityActions })
      .orderBy('audit.createdAt', 'DESC')
      .take(limit);

    if (tenantId) {
      queryBuilder.andWhere('audit.tenantId = :tenantId', { tenantId });
    } else {
      // Explicit platform-wide branch. No WHERE clause on tenantId is
      // intentional — documented in the JSDoc above. The `1=1`-style
      // implicit case has been replaced with this explicit branch so a
      // reader cannot mistake it for a missing filter.
      this.logger?.debug(
        'getSecurityLogs called without tenantId — returning platform-wide results (SUPER_ADMIN context required; bypass audited by AdminBypassRlsInterceptor)',
      );
    }

    return queryBuilder.getMany();
  }

  /**
   * Get audit log statistics
   * Returns data in format expected by frontend admin panel
   */
  async getStatistics(
    tenantId?: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<AuditStatisticsDto> {
    const asOf = new Date();
    if (startDate && Number.isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date');
    }
    if (endDate && Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date');
    }
    const boundedEndDate = endDate && endDate < asOf ? endDate : asOf;
    if (startDate && startDate > boundedEndDate) {
      throw new BadRequestException('startDate must not exceed the statistics cut endDate');
    }
    const last24HoursDate = new Date(asOf.getTime() - 24 * 60 * 60 * 1000);
    const scope: AuditStatisticsScopeV2 = createAuditStatisticsScopeV2({
      tenantId,
      startDate,
      endDate: boundedEndDate,
      asOf,
    });

    // One SQL statement owns both the observed cut and its qualified subset.
    // Imported legacy rows remain visible through observed/legacy counters but
    // can never inflate completeness, critical severity, or top-user claims.
    const rows = await this.auditLogRepository.query<AuditStatisticsAggregateRow[]>(
      `
        WITH observed AS MATERIALIZED (
          SELECT
            "action",
            "severity",
            "trustClass",
            "entityType",
            "performedBy",
            "performedByEmail",
            "createdAt"
          FROM "admin"."audit_logs"
          WHERE ($1::uuid IS NULL OR "tenantId" = $1::uuid)
            AND ($2::timestamptz IS NULL OR "createdAt" >= $2::timestamptz)
            AND "createdAt" <= $3::timestamptz
        ),
        scoped AS MATERIALIZED (
          SELECT
            "action",
            "severity",
            "entityType",
            "performedBy",
            "performedByEmail",
            "createdAt"
          FROM observed
          WHERE "trustClass" = 'AUTHORITATIVE_RUNTIME'
        ),
        action_counts AS (
          SELECT "action", COUNT(*) AS count
          FROM scoped
          GROUP BY "action"
        ),
        severity_counts AS (
          SELECT "severity", COUNT(*) AS count
          FROM scoped
          GROUP BY "severity"
        ),
        entity_type_counts AS (
          SELECT "entityType", COUNT(*) AS count
          FROM scoped
          GROUP BY "entityType"
        ),
        top_user_counts AS (
          SELECT "performedBy", "performedByEmail", COUNT(*) AS count
          FROM scoped
          GROUP BY "performedBy", "performedByEmail"
          ORDER BY count DESC, "performedBy" ASC, "performedByEmail" ASC NULLS LAST
          LIMIT 10
        )
        SELECT
          (SELECT COUNT(*)::text FROM scoped) AS total_logs,
          (SELECT COUNT(*)::text FROM observed) AS observed_logs,
          (
            SELECT COUNT(*)::text
            FROM observed
            WHERE "trustClass" = 'LEGACY_UNVERIFIED'
          ) AS legacy_unverified_logs,
          (
            SELECT COUNT(*)::text
            FROM scoped
            WHERE "createdAt" >= $4::timestamptz
          ) AS last_24_hours,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object('action', "action", 'count', count::text)
                ORDER BY count DESC, "action" ASC
              )
              FROM action_counts
            ),
            '[]'::jsonb
          ) AS by_action,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object('severity', "severity", 'count', count::text)
                ORDER BY count DESC, "severity" ASC
              )
              FROM severity_counts
            ),
            '[]'::jsonb
          ) AS by_severity,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object('entityType', "entityType", 'count', count::text)
                ORDER BY count DESC, "entityType" ASC
              )
              FROM entity_type_counts
            ),
            '[]'::jsonb
          ) AS by_entity_type,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'userId', "performedBy",
                  'email', "performedByEmail",
                  'count', count::text
                )
                ORDER BY count DESC, "performedBy" ASC, "performedByEmail" ASC NULLS LAST
              )
              FROM top_user_counts
            ),
            '[]'::jsonb
          ) AS top_users
      `,
      [tenantId ?? null, startDate ?? null, boundedEndDate, last24HoursDate],
    );
    const aggregate = rows[0];
    if (!aggregate) {
      throw new ServiceUnavailableException('Audit statistics source omitted its aggregate row');
    }

    const byAction = parseAuditArray(aggregate.by_action, 'byAction').map((value, index) => {
      const row = parseAuditRecord(value, `byAction[${index}]`);
      return {
        action: parseAuditString(row.action, `byAction[${index}].action`),
        count: parseAuditCount(row.count, `byAction[${index}].count`),
      };
    });
    const bySeverity = parseAuditArray(aggregate.by_severity, 'bySeverity').map((value, index) => {
      const row = parseAuditRecord(value, `bySeverity[${index}]`);
      return {
        severity: parseAuditString(row.severity, `bySeverity[${index}].severity`),
        count: parseAuditCount(row.count, `bySeverity[${index}].count`),
      };
    });
    const byEntityType = parseAuditArray(aggregate.by_entity_type, 'byEntityType').map(
      (value, index) => {
        const row = parseAuditRecord(value, `byEntityType[${index}]`);
        return {
          entityType: parseAuditString(row.entityType, `byEntityType[${index}].entityType`),
          count: parseAuditCount(row.count, `byEntityType[${index}].count`),
        };
      },
    );
    const topUsers = parseAuditArray(aggregate.top_users, 'topUsers').map((value, index) => {
      const row = parseAuditRecord(value, `topUsers[${index}]`);
      const email = row.email;
      if (email !== null && typeof email !== 'string') {
        throw new ServiceUnavailableException(
          `Audit statistics source returned invalid topUsers[${index}].email`,
        );
      }
      return {
        userId: parseAuditString(row.userId, `topUsers[${index}].userId`),
        email,
        count: parseAuditCount(row.count, `topUsers[${index}].count`),
      };
    });

    const projection: AuditStatisticsDto = {
      scope,
      totalLogs: parseAuditCount(aggregate.total_logs, 'totalLogs'),
      observedLogs: parseAuditCount(aggregate.observed_logs, 'observedLogs'),
      legacyUnverifiedLogs: parseAuditCount(
        aggregate.legacy_unverified_logs,
        'legacyUnverifiedLogs',
      ),
      last24Hours: parseAuditCount(aggregate.last_24_hours, 'last24Hours'),
      byAction,
      bySeverity,
      byEntityType,
      topUsers,
    };
    if (!auditStatisticsProjectionHasValidEvidenceV2(projection)) {
      throw new ServiceUnavailableException(
        'Audit statistics projection did not reconcile to its scoped total',
      );
    }
    return projection;
  }
}
