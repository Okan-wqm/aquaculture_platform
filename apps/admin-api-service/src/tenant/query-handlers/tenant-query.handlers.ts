import { Injectable, NotFoundException, NotImplementedException, Optional } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { resolveAdminSqlIdentifier } from '@platform/admin-http-contracts';
import {
  assertSafeSchemaName,
  getTenantSchemaName,
  isValidUUID,
} from '@aquaculture/backend-common/database';
import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { RedisService } from '@aquaculture/backend-common/redis';
import { Repository, ILike, MoreThan, Between, FindOptionsWhere, DataSource } from 'typeorm';

import {
  TenantListItemDto,
  TenantResourceCounts,
  TenantSummaryDto,
  toTenantListItem,
  toTenantSummary,
} from '../dto/tenant-summary.dto';
import { TenantStatsDto, TenantUsageDto } from '../dto/tenant.dto';
import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';
import {
  GetTenantByIdQuery,
  GetTenantBySlugQuery,
  ListTenantsQuery,
  GetTenantStatsQuery,
  GetTenantUsageQuery,
  GetTenantsApproachingLimitsQuery,
  GetExpiringTrialsQuery,
  SearchTenantsQuery,
} from '../queries/tenant.queries';

@Injectable()
@QueryHandler(GetTenantByIdQuery)
export class GetTenantByIdHandler implements IQueryHandler<GetTenantByIdQuery, TenantSummaryDto> {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: GetTenantByIdQuery): Promise<TenantSummaryDto> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: query.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${query.tenantId}' not found`);
    }

    return toTenantSummary(tenant);
  }
}

@Injectable()
@QueryHandler(GetTenantBySlugQuery)
export class GetTenantBySlugHandler
  implements IQueryHandler<GetTenantBySlugQuery, TenantSummaryDto>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: GetTenantBySlugQuery): Promise<TenantSummaryDto> {
    const tenant = await this.tenantRepository.findOne({
      where: { slug: query.slug },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with slug '${query.slug}' not found`);
    }

    return toTenantSummary(tenant);
  }
}

/** The two per-tenant tables the list view counts — fixed literals by design. */
const COUNTED_TENANT_TABLES = ['farms', 'sensors'] as const;

@Injectable()
@QueryHandler(ListTenantsQuery)
export class ListTenantsHandler
  implements IQueryHandler<ListTenantsQuery, IStandardPaginatedResult<TenantListItemDto>>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListTenantsQuery): Promise<IStandardPaginatedResult<TenantListItemDto>> {
    const { filter, pagination, sort } = query;

    const page = pagination?.page || 1;
    const limit = Math.min(pagination?.limit || 20, 100);
    const skip = (page - 1) * limit;

    const queryBuilder = this.tenantRepository.createQueryBuilder('tenant');

    // Apply filters
    if (filter?.status) {
      queryBuilder.andWhere('tenant.status = :status', {
        status: filter.status,
      });
    }

    if (filter?.plan) {
      queryBuilder.andWhere('tenant.plan = :plan', { plan: filter.plan });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(tenant.name ILIKE :search OR tenant.slug ILIKE :search OR tenant.customDomain ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    // Apply sorting
    const sortField = sort?.field || 'createdAt';
    const sortOrder = sort?.order || 'DESC';
    const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';
    queryBuilder.orderBy(resolveAdminSqlIdentifier('GET /admin/tenants', sortField), safeSortOrder);

    // Apply pagination
    queryBuilder.skip(skip).take(limit);

    const [tenants, total] = await queryBuilder.getManyAndCount();

    // DB-ADMIN-HIGH-005: the list contract is TenantListItemDto (tier +
    // farmCount + sensorCount), not the raw entity — the admin-panel list
    // renders exactly these fields. Counts come from ONE batched round-trip
    // pair for the whole page, never per-tenant queries.
    const counts = await this.countTenantResources(tenants.map((tenant) => tenant.id));

    return createStandardPaginatedResult(
      tenants.map((tenant) =>
        toTenantListItem(tenant, counts.get(tenant.id) ?? { farmCount: 0, sensorCount: 0 }),
      ),
      total,
      page,
      limit,
    );
  }

  /**
   * Batched per-tenant farm/sensor counts for one list page.
   *
   * WHY batched: the per-tenant shape in TenantDetailService.countTenantResource
   * (information_schema probe + COUNT per table per tenant) is 4 queries/tenant —
   * an N+1 that turns a 100-row page into 400 round-trips. The list path instead
   * issues exactly TWO statements regardless of page size:
   *   1. one information_schema probe over ALL page schemas (a tenant whose
   *      schema/tables are not provisioned yet legitimately has 0 resources), and
   *   2. one UNION ALL statement counting every existing (schema, table) pair.
   *
   * Identifier safety: tenant ids come from the auth.tenants uuid PK, but they
   * are about to become SQL identifiers — each id is UUID-validated before
   * deriving its schema name (canonical getTenantSchemaName), and each schema
   * name coming back from information_schema is re-checked by
   * assertSafeSchemaName before interpolation. Table names never leave the
   * fixed two-literal set.
   */
  private async countTenantResources(
    tenantIds: string[],
  ): Promise<Map<string, TenantResourceCounts>> {
    const counts = new Map<string, TenantResourceCounts>(
      tenantIds.map((id) => [id, { farmCount: 0, sensorCount: 0 }]),
    );

    const schemaToTenant = new Map<string, string>();
    for (const id of tenantIds) {
      // A non-UUID id cannot own a tenant schema — it truthfully has 0 resources.
      if (isValidUUID(id)) {
        schemaToTenant.set(getTenantSchemaName(id), id);
      }
    }
    if (schemaToTenant.size === 0) {
      return counts;
    }

    const existingTables = await this.dataSource.query<
      Array<{ table_schema: string; table_name: string }>
    >(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_schema = ANY($1) AND table_name = ANY($2)`,
      [[...schemaToTenant.keys()], [...COUNTED_TENANT_TABLES]],
    );
    if (existingTables.length === 0) {
      return counts;
    }

    const countSql = existingTables
      .map(({ table_schema, table_name }) => {
        assertSafeSchemaName(table_schema);
        return `SELECT '${table_schema}' AS schema_name, '${table_name}' AS table_name, COUNT(*)::int AS row_count FROM "${table_schema}"."${table_name}"`;
      })
      .join(' UNION ALL ');
    const rows =
      await this.dataSource.query<
        Array<{ schema_name: string; table_name: string; row_count: number }>
      >(countSql);

    for (const row of rows) {
      const tenantId = schemaToTenant.get(row.schema_name);
      const entry = tenantId ? counts.get(tenantId) : undefined;
      if (!entry) {
        continue;
      }
      if (row.table_name === 'farms') {
        entry.farmCount = row.row_count;
      } else {
        entry.sensorCount = row.row_count;
      }
    }
    return counts;
  }
}

/**
 * OPTIMIZED: Redis caching with 1 hour TTL for expensive aggregate queries.
 */
@Injectable()
@QueryHandler(GetTenantStatsQuery)
export class GetTenantStatsHandler implements IQueryHandler<GetTenantStatsQuery, TenantStatsDto> {
  private static readonly CACHE_KEY = 'tenant:stats:global';
  private static readonly CACHE_TTL = 3600; // 1 hour

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  async execute(): Promise<TenantStatsDto> {
    // Check Redis cache first
    if (this.redisService) {
      try {
        const cached = await this.redisService.getJson<TenantStatsDto>(
          GetTenantStatsHandler.CACHE_KEY,
        );
        if (cached) {
          return cached;
        }
      } catch {
        // Cache miss or error, continue to compute
      }
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalTenants,
      activeTenants,
      suspendedTenants,
      pendingTenants,
      byPlanResults,
      newTenantsLast30Days,
      churnedTenantsLast30Days,
    ] = await Promise.all([
      this.tenantRepository.count(),
      this.tenantRepository.count({ where: { status: TenantStatus.ACTIVE } }),
      this.tenantRepository.count({ where: { status: TenantStatus.SUSPENDED } }),
      this.tenantRepository.count({ where: { status: TenantStatus.PENDING } }),
      this.tenantRepository
        .createQueryBuilder('tenant')
        .select('tenant.plan', 'plan')
        .addSelect('COUNT(*)', 'count')
        .groupBy('tenant.plan')
        .getRawMany(),
      this.tenantRepository.count({
        where: { createdAt: MoreThan(thirtyDaysAgo) },
      }),
      this.tenantRepository.count({
        where: {
          status: TenantStatus.CANCELLED,
          updatedAt: MoreThan(thirtyDaysAgo),
        },
      }),
    ]);

    const byPlan: Record<string, number> = {
      [TenantPlan.TRIAL]: 0,
      [TenantPlan.STARTER]: 0,
      [TenantPlan.PROFESSIONAL]: 0,
      [TenantPlan.ENTERPRISE]: 0,
    };

    for (const result of byPlanResults) {
      byPlan[result.plan as TenantPlan] = parseInt(result.count, 10);
    }

    const result: TenantStatsDto = {
      totalTenants,
      activeTenants,
      suspendedTenants,
      pendingTenants,
      byPlan,
      newTenantsLast30Days,
      churnedTenantsLast30Days,
    };

    // Cache the result
    if (this.redisService) {
      this.redisService
        .setJson(GetTenantStatsHandler.CACHE_KEY, result, GetTenantStatsHandler.CACHE_TTL)
        .catch(() => {
          // Ignore cache write errors
        });
    }

    return result;
  }
}

@Injectable()
@QueryHandler(GetTenantUsageQuery)
export class GetTenantUsageHandler implements IQueryHandler<GetTenantUsageQuery, TenantUsageDto> {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTenantUsageQuery): Promise<TenantUsageDto> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: query.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${query.tenantId}' not found`);
    }

    // Get actual user count from users table in public schema
    const userCountResult = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM auth.users WHERE "tenantId" = $1 AND "isActive" = true`,
      [query.tenantId],
    );
    const currentUserCount = parseInt(userCountResult[0]?.count || '0', 10);

    const calculatePercentage = (used: number, max: number): number => {
      if (max === -1) return 0; // unlimited
      if (max === 0) return 100;
      return Math.round((used / max) * 100);
    };

    return {
      tenantId: tenant.id,
      maxUsers: tenant.maxUsers,
      currentUserCount,
      usagePercentage: calculatePercentage(currentUserCount, tenant.maxUsers),
    };
  }
}

@Injectable()
@QueryHandler(GetTenantsApproachingLimitsQuery)
export class GetTenantsApproachingLimitsHandler
  implements IQueryHandler<GetTenantsApproachingLimitsQuery, TenantSummaryDto[]>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(_query: GetTenantsApproachingLimitsQuery): Promise<TenantSummaryDto[]> {
    // C-9 fix: Block endpoint with 501 until actual limit checking is implemented.
    // Previous implementation returned ALL active tenants unconditionally.
    throw new NotImplementedException(
      'Tenants approaching limits endpoint is not yet implemented. Requires JOIN against users table for actual limit checking.',
    );
  }
}

@Injectable()
@QueryHandler(GetExpiringTrialsQuery)
export class GetExpiringTrialsHandler
  implements IQueryHandler<GetExpiringTrialsQuery, TenantSummaryDto[]>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: GetExpiringTrialsQuery): Promise<TenantSummaryDto[]> {
    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + query.withinDays);

    const tenants = await this.tenantRepository.find({
      where: {
        trialEndsAt: Between(now, futureDate),
        status: TenantStatus.ACTIVE,
      },
      order: { trialEndsAt: 'ASC' },
    });

    return tenants.map(toTenantSummary);
  }
}

@Injectable()
@QueryHandler(SearchTenantsQuery)
export class SearchTenantsHandler implements IQueryHandler<SearchTenantsQuery, TenantSummaryDto[]> {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: SearchTenantsQuery): Promise<TenantSummaryDto[]> {
    const { searchTerm, limit } = query;

    const tenants = await this.tenantRepository.find({
      where: [
        { name: ILike(`%${searchTerm}%`) },
        { slug: ILike(`%${searchTerm}%`) },
        { customDomain: ILike(`%${searchTerm}%`) },
      ],
      take: limit,
      order: { name: 'ASC' },
    });

    return tenants.map(toTenantSummary);
  }
}
