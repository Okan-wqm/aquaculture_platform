/**
 * HarvestResolver
 *
 * GraphQL resolvers for harvest operations.
 * Provides comprehensive CRUD operations and statistics queries.
 *
 * @module Harvest/Resolvers
 */
import { Tenant, CurrentUser, Roles, Role, RequiresMobileFeature } from '@aquaculture/backend-common/decorators';
import { TenantGuard, MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { mobileCommandEnvelopeFromInput } from '@aquaculture/backend-common/mobile-command';
import { StandardPaginatedResponse, fromCqrsPaginated, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { UseGuards, Logger } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  Float,
  ObjectType,
  Field,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';

import { CreateHarvestRecordCommand } from '../commands/create-harvest-record.command';
import { DeleteHarvestRecordCommand } from '../commands/delete-harvest-record.command';
import { UpdateHarvestRecordCommand } from '../commands/update-harvest-record.command';
import { CreateHarvestRecordInput } from '../dto/create-harvest-record.input';
import { HarvestFilterInput, HarvestPaginationInput, DateRangeInput } from '../dto/harvest-filter.input';
import { UpdateHarvestRecordInput } from '../dto/update-harvest-record.input';
import { HarvestRecord, HarvestRecordStatus, QualityGrade } from '../entities/harvest-record.entity';
import { HarvestStatistics } from '../handlers/get-harvest-statistics.handler';
import { GetHarvestStatisticsQuery } from '../queries/get-harvest-statistics.query';
import { GetHarvestQuery } from '../queries/get-harvest.query';
import { ListHarvestsQuery } from '../queries/list-harvests.query';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

/**
 * User context interface for CurrentUser decorator
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  // SEC-MEDIUM-050 / FE-MEDIUM-051: roles typed as the canonical Role[] (the JWT
  // guard validates enum membership before the resolver), so the site-authz
  // threading below carries the SSoT vocabulary, not loose strings.
  roles: Role[];
  // SEC-HIGH-051: the caller's assigned farm Site ids (object-level site authz).
  assignedSiteIds?: string[];
}

/**
 * Paginated harvest records response
 */
@ObjectType()
export class PaginatedHarvestsResponse extends StandardPaginatedResponse(HarvestRecord) {}

/**
 * Status statistics item
 */
@ObjectType()
export class HarvestStatusStats {
  @Field(() => HarvestRecordStatus)
  status: HarvestRecordStatus;

  @Field(() => Int)
  count: number;

  @Field(() => Float)
  totalBiomass: number;
}

/**
 * Quality grade statistics item
 */
@ObjectType()
export class HarvestQualityStats {
  @Field(() => QualityGrade)
  grade: QualityGrade;

  @Field(() => Int)
  count: number;

  @Field(() => Float)
  totalBiomass: number;

  @Field(() => Float)
  percentage: number;
}

/**
 * Monthly statistics item
 */
@ObjectType()
export class HarvestMonthlyStats {
  @Field(() => Int)
  year: number;

  @Field(() => Int)
  month: number;

  @Field(() => Int)
  count: number;

  @Field(() => Float)
  totalBiomass: number;

  @Field(() => Float)
  totalRevenue: number;
}

/**
 * Harvest summary statistics
 */
@ObjectType()
export class HarvestSummary {
  @Field(() => Int)
  totalHarvests: number;

  @Field(() => Int)
  totalQuantityHarvested: number;

  @Field(() => Float)
  totalBiomassKg: number;

  @Field(() => Float)
  totalRevenue: number;

  @Field(() => Float)
  averageWeight: number;

  @Field(() => Float)
  averagePricePerKg: number;
}

/**
 * Harvest trends
 */
@ObjectType()
export class HarvestTrends {
  @Field(() => Float)
  avgBiomassPerHarvest: number;

  @Field(() => Float)
  avgQuantityPerHarvest: number;

  @Field(() => Float)
  harvestsPerMonth: number;
}

/**
 * Harvest statistics response
 */
@ObjectType()
export class HarvestStatisticsResponse {
  @Field()
  tenantId: string;

  @Field()
  startDate: Date;

  @Field()
  endDate: Date;

  @Field(() => HarvestSummary)
  summary: HarvestSummary;

  @Field(() => [HarvestStatusStats])
  byStatus: HarvestStatusStats[];

  @Field(() => [HarvestQualityStats])
  byQualityGrade: HarvestQualityStats[];

  @Field(() => [HarvestMonthlyStats])
  byMonth: HarvestMonthlyStats[];

  @Field(() => HarvestTrends)
  trends: HarvestTrends;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => HarvestRecord)
// SEC-HIGH-052: MobileFeatureGuard enforces the 'harvest' entitlement on
// createHarvestRecord (no-op on other routes). It NEVER relaxes the @Roles
// floor (SEC-MEDIUM-050) — both the role gate AND the feature gate apply.
@UseGuards(TenantGuard, MobileFeatureGuard)
export class HarvestResolver {
  private readonly logger = new Logger(HarvestResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * List all harvest records with filtering and pagination
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedHarvestsResponse, { description: 'List harvest records with filtering and pagination' })
  async harvests(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => HarvestFilterInput, nullable: true }) filter?: HarvestFilterInput,
    @Args('pagination', { type: () => HarvestPaginationInput, nullable: true }) pagination?: HarvestPaginationInput,
  ): Promise<IStandardPaginatedResult<HarvestRecord>> {
    this.logger.log(`Listing harvests for tenant ${tenantId}`);

    const query = new ListHarvestsQuery(
      tenantId,
      filter ? {
        batchId: filter.batchId,
        batchIds: filter.batchIds,
        tankId: filter.tankId,
        tankIds: filter.tankIds,
        pondId: filter.pondId,
        siteId: filter.siteId,
        status: filter.status,
        statuses: filter.statuses,
        qualityClass: filter.qualityClass,
        qualityClasses: filter.qualityClasses,
        qualityGrade: filter.qualityGrade,
        qualityGrades: filter.qualityGrades,
        method: filter.method,
        productForm: filter.productForm,
        startDate: filter.startDate,
        endDate: filter.endDate,
        qualityApproved: filter.qualityApproved,
        harvestedBy: filter.harvestedBy,
        search: filter.search,
        minBiomass: filter.minBiomass,
        maxBiomass: filter.maxBiomass,
        minAverageWeight: filter.minAverageWeight,
        maxAverageWeight: filter.maxAverageWeight,
        minQuantity: filter.minQuantity,
        maxQuantity: filter.maxQuantity,
      } : undefined,
      pagination ? {
        page: pagination.page,
        limit: pagination.limit,
        sortBy: pagination.sortBy,
        sortOrder: pagination.sortOrder,
      } : undefined,
    );

    const result = await this.queryBus.execute<ListHarvestsQuery, PaginatedQueryResult<HarvestRecord>>(query);
    return fromCqrsPaginated(result);
  }

  /**
   * Get a single harvest record by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => HarvestRecord, { nullable: true, description: 'Get a single harvest record by ID' })
  async harvest(
    @Tenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HarvestRecord | null> {
    this.logger.log(`Getting harvest ${id} for tenant ${tenantId}`);

    const query = new GetHarvestQuery(tenantId, id);
    return this.queryBus.execute(query);
  }

  /**
   * Get harvest records for a specific batch
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedHarvestsResponse, { description: 'Get harvest records for a specific batch' })
  async harvestsByBatch(
    @Tenant() tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('pagination', { type: () => HarvestPaginationInput, nullable: true }) pagination?: HarvestPaginationInput,
  ): Promise<IStandardPaginatedResult<HarvestRecord>> {
    this.logger.log(`Listing harvests for batch ${batchId} in tenant ${tenantId}`);

    const query = new ListHarvestsQuery(
      tenantId,
      { batchId },
      pagination ? {
        page: pagination.page,
        limit: pagination.limit,
        sortBy: pagination.sortBy || 'harvestDate',
        sortOrder: pagination.sortOrder || 'DESC',
      } : { sortBy: 'harvestDate', sortOrder: 'DESC' },
    );

    const result = await this.queryBus.execute<ListHarvestsQuery, PaginatedQueryResult<HarvestRecord>>(query);
    return fromCqrsPaginated(result);
  }

  /**
   * Get harvest statistics for a tenant within a date range
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => HarvestStatisticsResponse, { description: 'Get harvest statistics for a tenant within a date range' })
  async harvestStatistics(
    @Tenant() tenantId: string,
    @Args('dateRange', { type: () => DateRangeInput }) dateRange: DateRangeInput,
  ): Promise<HarvestStatisticsResponse> {
    this.logger.log(
      `Getting harvest statistics for tenant ${tenantId} from ` +
        `${dateRange.startDate.toISOString()} to ${dateRange.endDate.toISOString()}`,
    );

    const query = new GetHarvestStatisticsQuery(tenantId, {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    });

    const result: HarvestStatistics = await this.queryBus.execute(query);

    return {
      tenantId: result.tenantId,
      startDate: result.dateRange.startDate,
      endDate: result.dateRange.endDate,
      summary: result.summary,
      byStatus: result.byStatus,
      byQualityGrade: result.byQualityGrade,
      byMonth: result.byMonth,
      trends: result.trends,
    };
  }

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  /**
   * Create a new harvest record
   */
  // Return HarvestRecord (not Batch) so the frontend receives harvest-specific fields.
  // SEC-MEDIUM-050: the role floor is the SSoT — createHarvestRecord stays
  // MODULE_MANAGER+ (NO MODULE_USER). The mobile 'harvest' feature gate below
  // NEVER widens it; both gates apply.
  // Keep this comment ABOVE @Mutation: the farm-graphql-fe-be-parity extractor
  // skips interleaved DECORATORS but not comments, so a comment between
  // @Mutation and the method hides the field from the FE↔BE parity scan.
  @Mutation(() => HarvestRecord, { description: 'Create a harvest record and update batch/tank quantities' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @RequiresMobileFeature('harvest')
  async createHarvestRecord(
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('input') input: CreateHarvestRecordInput,
  ): Promise<HarvestRecord> {
    this.logger.log(`Creating harvest record for tenant ${tenantId} by user ${user.sub}`);

    return this.commandBus.execute(
      new CreateHarvestRecordCommand(
        tenantId,
        input,
        user.sub,
        user.roles,
        user.assignedSiteIds ?? [],
        mobileCommandEnvelopeFromInput(input),
      ),
    );
  }

  /**
   * Update an existing harvest record
   */
  @Mutation(() => HarvestRecord, { description: 'Update an existing harvest record' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateHarvestRecord(
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('input') input: UpdateHarvestRecordInput,
  ): Promise<HarvestRecord> {
    this.logger.log(`Updating harvest record ${input.id} for tenant ${tenantId} by user ${user.sub}`);

    return this.commandBus.execute(
      new UpdateHarvestRecordCommand(
        tenantId,
        input.id,
        {
          status: input.status,
          quantityHarvested: input.quantityHarvested,
          totalBiomass: input.totalBiomass,
          averageWeight: input.averageWeight,
          qualityClass: input.qualityClass,
          qualityGrade: input.qualityGrade,
          method: input.method,
          productForm: input.productForm,
          totalRevenue: input.totalRevenue,
          harvestCost: input.harvestCost,
          currency: input.currency,
          mortalityDuringHarvest: input.mortalityDuringHarvest,
          rejectedQuantity: input.rejectedQuantity,
          rejectionReason: input.rejectionReason,
          notes: input.notes,
        },
        user.sub
      )
    );
  }

  /**
   * Delete (soft delete) a harvest record
   */
  @Mutation(() => Boolean, { description: 'Delete (cancel) a harvest record and reverse quantity changes' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deleteHarvestRecord(
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting harvest record ${id} for tenant ${tenantId} by user ${user.sub}`);

    return this.commandBus.execute(
      new DeleteHarvestRecordCommand(tenantId, id, user.sub)
    );
  }

  // ==========================================================================
  // FIELD RESOLVERS
  // ==========================================================================

  /**
   * Calculate net yield (after rejected quantity)
   */
  @ResolveField(() => Float)
  netBiomass(@Parent() harvest: HarvestRecord): number {
    const rejected = Number(harvest.rejectedQuantity || 0);
    return Number(harvest.totalBiomass) - rejected;
  }

  /**
   * Calculate price per kg
   */
  @ResolveField(() => Float, { nullable: true })
  pricePerKg(@Parent() harvest: HarvestRecord): number | null {
    if (!harvest.totalRevenue || !harvest.totalBiomass) return null;
    return Number(harvest.totalRevenue) / Number(harvest.totalBiomass);
  }

  /**
   * Calculate profit margin
   */
  @ResolveField(() => Float, { nullable: true })
  profitMargin(@Parent() harvest: HarvestRecord): number | null {
    if (!harvest.totalRevenue || !harvest.harvestCost) return null;
    const revenue = Number(harvest.totalRevenue);
    const cost = Number(harvest.harvestCost);
    if (revenue === 0) return null;
    return ((revenue - cost) / revenue) * 100;
  }

  /**
   * Check if harvest is complete
   */
  @ResolveField(() => Boolean)
  isComplete(@Parent() harvest: HarvestRecord): boolean {
    return harvest.status === HarvestRecordStatus.COMPLETED ||
           harvest.status === HarvestRecordStatus.DISPATCHED ||
           harvest.status === HarvestRecordStatus.DELIVERED;
  }

  /**
   * Check if harvest can be edited
   */
  @ResolveField(() => Boolean)
  canEdit(@Parent() harvest: HarvestRecord): boolean {
    return harvest.status !== HarvestRecordStatus.DISPATCHED &&
           harvest.status !== HarvestRecordStatus.DELIVERED &&
           harvest.status !== HarvestRecordStatus.CANCELLED;
  }

  /**
   * Check if harvest can be deleted
   */
  @ResolveField(() => Boolean)
  canDelete(@Parent() harvest: HarvestRecord): boolean {
    return harvest.status !== HarvestRecordStatus.DISPATCHED &&
           harvest.status !== HarvestRecordStatus.DELIVERED &&
           harvest.status !== HarvestRecordStatus.CANCELLED;
  }

  /**
   * Get rejection percentage
   */
  @ResolveField(() => Float)
  rejectionPercentage(@Parent() harvest: HarvestRecord): number {
    if (!harvest.rejectedQuantity || !harvest.totalBiomass) return 0;
    return (Number(harvest.rejectedQuantity) / Number(harvest.totalBiomass)) * 100;
  }

  /**
   * Get mortality percentage during harvest
   */
  @ResolveField(() => Float)
  harvestMortalityPercentage(@Parent() harvest: HarvestRecord): number {
    if (!harvest.mortalityDuringHarvest || !harvest.quantityHarvested) return 0;
    const totalAttempted = harvest.quantityHarvested + harvest.mortalityDuringHarvest;
    return (harvest.mortalityDuringHarvest / totalAttempted) * 100;
  }
}
