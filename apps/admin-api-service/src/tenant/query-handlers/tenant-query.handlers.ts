import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, MoreThan, Between, FindOptionsWhere, DataSource } from 'typeorm';
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
import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';
import { TenantStatsDto, TenantUsageDto } from '../dto/tenant.dto';
import { RedisService } from '@platform/backend-common';

@Injectable()
@QueryHandler(GetTenantByIdQuery)
export class GetTenantByIdHandler
  implements IQueryHandler<GetTenantByIdQuery, Tenant>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: GetTenantByIdQuery): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: query.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(
        `Tenant with ID '${query.tenantId}' not found`,
      );
    }

    return tenant;
  }
}

@Injectable()
@QueryHandler(GetTenantBySlugQuery)
export class GetTenantBySlugHandler
  implements IQueryHandler<GetTenantBySlugQuery, Tenant>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: GetTenantBySlugQuery): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({
      where: { slug: query.slug },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with slug '${query.slug}' not found`);
    }

    return tenant;
  }
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
@QueryHandler(ListTenantsQuery)
export class ListTenantsHandler
  implements IQueryHandler<ListTenantsQuery, PaginatedResult<Tenant>>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: ListTenantsQuery): Promise<PaginatedResult<Tenant>> {
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
    const allowedSortFields = [
      'name',
      'createdAt',
      'updatedAt',
      'status',
      'plan',
      'maxUsers',
    ];

    if (allowedSortFields.includes(sortField)) {
      queryBuilder.orderBy(`tenant.${sortField}`, sortOrder);
    } else {
      queryBuilder.orderBy('tenant.createdAt', 'DESC');
    }

    // Apply pagination
    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}

/**
 * OPTIMIZED: Redis caching with 1 hour TTL for expensive aggregate queries.
 */
@Injectable()
@QueryHandler(GetTenantStatsQuery)
export class GetTenantStatsHandler
  implements IQueryHandler<GetTenantStatsQuery, TenantStatsDto>
{
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
        const cached = await this.redisService.getJson<TenantStatsDto>(GetTenantStatsHandler.CACHE_KEY);
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
      this.redisService.setJson(GetTenantStatsHandler.CACHE_KEY, result, GetTenantStatsHandler.CACHE_TTL).catch(() => {
        // Ignore cache write errors
      });
    }

    return result;
  }
}

@Injectable()
@QueryHandler(GetTenantUsageQuery)
export class GetTenantUsageHandler
  implements IQueryHandler<GetTenantUsageQuery, TenantUsageDto>
{
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
      throw new NotFoundException(
        `Tenant with ID '${query.tenantId}' not found`,
      );
    }

    // Get actual user count from users table in public schema
    const userCountResult = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM public.users WHERE "tenantId" = $1 AND "isActive" = true`,
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
  implements IQueryHandler<GetTenantsApproachingLimitsQuery, Tenant[]>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: GetTenantsApproachingLimitsQuery): Promise<Tenant[]> {
    // Get active tenants
    const tenants = await this.tenantRepository.find({
      where: { status: TenantStatus.ACTIVE },
    });

    // For now, return all active tenants (limit checking requires user count)
    return tenants;
  }
}

@Injectable()
@QueryHandler(GetExpiringTrialsQuery)
export class GetExpiringTrialsHandler
  implements IQueryHandler<GetExpiringTrialsQuery, Tenant[]>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: GetExpiringTrialsQuery): Promise<Tenant[]> {
    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + query.withinDays);

    return this.tenantRepository.find({
      where: {
        trialEndsAt: Between(now, futureDate),
        status: TenantStatus.ACTIVE,
      },
      order: { trialEndsAt: 'ASC' },
    });
  }
}

@Injectable()
@QueryHandler(SearchTenantsQuery)
export class SearchTenantsHandler
  implements IQueryHandler<SearchTenantsQuery, Tenant[]>
{
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(query: SearchTenantsQuery): Promise<Tenant[]> {
    const { searchTerm, limit } = query;

    return this.tenantRepository.find({
      where: [
        { name: ILike(`%${searchTerm}%`) },
        { slug: ILike(`%${searchTerm}%`) },
        { customDomain: ILike(`%${searchTerm}%`) },
      ],
      take: limit,
      order: { name: 'ASC' },
    });
  }
}
