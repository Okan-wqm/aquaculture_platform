/**
 * Growth GraphQL Resolver
 *
 * Büyüme ölçümleri ve analiz için GraphQL API.
 * CQRS pattern ile CommandBus ve QueryBus kullanır.
 *
 * @module Growth/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  Float,
  ResolveField,
  Parent,
  InputType,
  Field,
  ObjectType,
} from '@nestjs/graphql';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { StandardPaginationInput, StandardPaginatedResponse, fromCqrsPaginated, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { Cacheable } from '../../common/cache/cacheable.decorator';
import { CacheEvict } from '../../common/cache/cache-evict.decorator';
import GraphQLJSON from 'graphql-type-json';

// Entities
import {
  GrowthMeasurement,
  MeasurementType,
  MeasurementMethod,
  GrowthPerformance,
  IndividualMeasurement,
  MeasurementConditions,
} from '../entities/growth-measurement.entity';

// Commands
import { RecordGrowthSampleCommand } from '../commands/record-growth-sample.command';
import { UpdateBatchWeightFromSampleCommand } from '../commands/update-batch-weight-from-sample.command';
import { VerifyMeasurementCommand } from '../commands/verify-measurement.command';

// Queries
import { GetGrowthMeasurementsQuery } from '../queries/get-growth-measurements.query';
import { GetGrowthAnalysisQuery } from '../queries/get-growth-analysis.query';
import { GetLatestMeasurementQuery } from '../queries/get-latest-measurement.query';

// ============================================================================
// INPUT TYPES
// ============================================================================

/** What the operator reports about the fish's feeding before the weighing. */
const FEEDING_STATUSES: ReadonlyArray<MeasurementConditions['feedingStatus']> = [
  'fed',
  'fasted_12h',
  'fasted_24h',
  'unknown',
];

// Every property below carries a validator: the global ValidationPipe runs with
// whitelist + forbidNonWhitelisted, so a `@Field`-only property is "not
// whitelisted" and ANY request that sends it is rejected (FARM-HIGH-482,
// PLAT-HIGH-922). The bounds mirror the physical limits the entity already
// assumes (growth/dto/create-growth-measurement.input.ts).

@InputType()
export class IndividualMeasurementInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  sampleNumber!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  @Max(100000)
  weight!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(500)
  length?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(100)
  width?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@InputType()
export class MeasurementConditionsInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(-5)
  @Max(45)
  waterTemp?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  dissolvedOxygen?: number;

  @Field()
  @IsIn(FEEDING_STATUSES)
  feedingStatus!: string;

  @Field()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'timeOfDay must be HH:mm' })
  timeOfDay!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  weatherConditions?: string;
}

@InputType()
export class RecordGrowthSampleInput {
  @Field(() => ID)
  @IsUUID()
  batchId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field()
  @IsDate()
  @Type(() => Date)
  measurementDate!: Date;

  @Field(() => MeasurementType, { defaultValue: MeasurementType.ROUTINE })
  @IsEnum(MeasurementType)
  measurementType!: MeasurementType;

  @Field(() => MeasurementMethod, { defaultValue: MeasurementMethod.MANUAL_SCALE })
  @IsEnum(MeasurementMethod)
  measurementMethod!: MeasurementMethod;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(10000)
  sampleSize!: number;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  populationSize!: number;

  @Field(() => [IndividualMeasurementInput])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => IndividualMeasurementInput)
  individualMeasurements!: IndividualMeasurementInput[];

  @Field(() => MeasurementConditionsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => MeasurementConditionsInput)
  conditions?: MeasurementConditionsInput;

  /** The user who took the measurement: a user id (the column is a uuid), never a display name. */
  @Field(() => ID)
  @IsUUID()
  measuredBy!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field({ defaultValue: true })
  @IsBoolean()
  updateBatchWeight!: boolean;
}

@InputType()
export class GrowthMeasurementFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => MeasurementType, { nullable: true })
  @IsOptional()
  @IsEnum(MeasurementType)
  measurementType?: MeasurementType;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  startDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  verifiedOnly?: boolean;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsEnum(GrowthPerformance, { each: true })
  performance?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  measuredBy?: string;
}

@InputType('GrowthPaginationInput')
export class GrowthPaginationInput extends StandardPaginationInput {}

// ============================================================================
// RESPONSE TYPES (Order matters - referenced types must be defined first)
// ============================================================================

// GrowthMetrics must be defined BEFORE GrowthAnalysisResponse to avoid
// "Cannot access 'X' before initialization" errors
@ObjectType()
export class GrowthMetrics {
  @Field(() => Float)
  currentAvgWeightG!: number;

  @Field(() => Float)
  theoreticalWeightG!: number;

  @Field(() => Float)
  weightVariancePercent!: number;

  @Field(() => Float)
  currentBiomassKg!: number;

  @Field(() => Int)
  currentQuantity!: number;

  @Field(() => Float)
  survivalRate!: number;

  @Field(() => Float)
  mortalityRate!: number;

  @Field(() => Float)
  currentFCR!: number;

  @Field(() => Float)
  targetFCR!: number;

  @Field(() => Float)
  fcrVariancePercent!: number;

  @Field(() => Float)
  dailyGrowthRateG!: number;

  @Field(() => Float)
  specificGrowthRate!: number;

  @Field(() => Float)
  weightCV!: number;

  @Field(() => GrowthPerformance)
  performanceRating!: GrowthPerformance;
}

@ObjectType()
export class GrowthTrend {
  @Field()
  direction!: string;

  @Field(() => Float)
  avgDailyGrowthLast7Days!: number;

  @Field(() => Float)
  avgDailyGrowthLast30Days!: number;

  @Field(() => Float)
  growthAcceleration!: number;

  @Field()
  fcrTrend!: string;

  @Field(() => Float)
  fcrChangeLast7Days!: number;
}

@ObjectType()
export class GrowthProjection {
  @Field(() => Float)
  projectedWeightIn30Days!: number;

  @Field(() => Float)
  projectedBiomassIn30Days!: number;

  @Field()
  estimatedHarvestDate!: Date;

  @Field(() => Float)
  harvestTargetWeightG!: number;

  @Field(() => Int)
  daysToHarvest!: number;

  @Field(() => Float)
  projectedTotalFeedKg!: number;

  @Field(() => Float)
  projectedFinalFCR!: number;
}

@ObjectType()
export class GrowthRecommendation {
  @Field()
  priority!: string;

  @Field()
  type!: string;

  @Field()
  description!: string;

  @Field()
  reason!: string;

  @Field({ nullable: true })
  actionRequired?: string;
}

@ObjectType()
export class GrowthMeasurementSummary {
  @Field(() => ID)
  id!: string;

  @Field()
  measurementDate!: Date;

  @Field(() => Float)
  averageWeight!: number;

  @Field(() => Float)
  weightCV!: number;

  @Field(() => Int)
  sampleSize!: number;

  @Field(() => Float)
  estimatedBiomass!: number;

  @Field(() => Float, { nullable: true })
  dailyGrowthRate?: number;

  @Field(() => Float, { nullable: true })
  periodFCR?: number;

  @Field(() => GrowthPerformance, { nullable: true })
  performance?: GrowthPerformance;
}

@ObjectType()
export class SGRCalculationResponse {
  @Field(() => Float)
  sgr!: number;

  @Field(() => Float)
  initialWeight!: number;

  @Field(() => Float)
  finalWeight!: number;

  @Field(() => Int)
  daysBetween!: number;

  @Field()
  rating!: string;

  @Field({ nullable: true })
  speciesTargetSGR?: number;

  @Field(() => Float, { nullable: true })
  varianceFromTarget?: number;
}

@ObjectType()
export class BiomassEstimateResponse {
  @Field(() => Float)
  biomassKg!: number;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Float)
  avgWeightG!: number;

  @Field()
  method!: string;

  @Field()
  confidence!: string;

  @Field({ nullable: true })
  lastMeasurementDate?: Date;
}

// Types that reference other types - must come after their dependencies
@ObjectType()
export class GrowthMeasurementConnection extends StandardPaginatedResponse(GrowthMeasurement) {}

@ObjectType()
export class GrowthAnalysisResponse {
  @Field(() => ID)
  batchId!: string;

  @Field()
  batchCode!: string;

  @Field()
  speciesName!: string;

  @Field()
  analysisDate!: Date;

  @Field(() => Int)
  daysInProduction!: number;

  @Field(() => GrowthMetrics)
  currentMetrics!: GrowthMetrics;

  @Field(() => GrowthTrend)
  trend!: GrowthTrend;

  @Field(() => GrowthProjection)
  projection!: GrowthProjection;

  @Field(() => [GrowthRecommendation])
  recommendations!: GrowthRecommendation[];

  @Field(() => [GrowthMeasurementSummary])
  measurementHistory!: GrowthMeasurementSummary[];
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(TenantGuard)
@Resolver(() => GrowthMeasurement)
export class GrowthResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get growth measurement by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => GrowthMeasurement, { nullable: true })
  async growthMeasurement(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<GrowthMeasurement | null> {
    // Fail-closed tenant boundary: a lost pooled-connection search_path must
    // raise, not silently resolve the wrong schema for a single-record read.
    return runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      queryRunner.manager.findOne(GrowthMeasurement, {
        where: { id, tenantId },
        relations: ['batch'],
      }),
    );
  }

  /**
   * List growth measurements with filters
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => GrowthMeasurementConnection)
  async growthMeasurements(
    @CurrentTenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: GrowthMeasurementFilterInput,
    @Args('pagination', { nullable: true }) pagination?: GrowthPaginationInput,
  ): Promise<IStandardPaginatedResult<GrowthMeasurement>> {
    const result: PaginatedQueryResult<GrowthMeasurement> = await this.queryBus.execute(
      new GetGrowthMeasurementsQuery(
        tenantId,
        {
          batchId: filter?.batchId,
          tankId: filter?.tankId,
          measurementType: filter?.measurementType ? [filter.measurementType] : undefined,
          performance: filter?.performance as GrowthPerformance[] | undefined,
          fromDate: filter?.startDate,
          toDate: filter?.endDate,
          isVerified: filter?.verifiedOnly,
          measuredBy: filter?.measuredBy,
        },
        pagination?.page ?? 1,
        pagination?.limit ?? 20,
      ),
    );
    return fromCqrsPaginated(result);
  }

  /**
   * Get growth analysis for a batch.
   *
   * Phase 7.3.1 — cached via @Cacheable with 2-hour TTL. The
   * underlying handler used to carry its own Redis read-through
   * block; the cache now lives at the resolver boundary so the
   * whole service uses one caching pattern.
   */
  @Cacheable({ prefix: 'growth:analysis', ttlSeconds: 7200 })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => GrowthAnalysisResponse)
  async growthAnalysis(
    @CurrentTenant() tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
  ): Promise<GrowthAnalysisResponse> {
    return this.queryBus.execute(
      new GetGrowthAnalysisQuery(tenantId, batchId),
    );
  }

  /**
   * Get latest measurement for a batch
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => GrowthMeasurement, { nullable: true })
  async latestGrowthMeasurement(
    @CurrentTenant() tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
  ): Promise<GrowthMeasurement | null> {
    return this.queryBus.execute(
      new GetLatestMeasurementQuery(tenantId, batchId),
    );
  }

  /**
   * Get measurements for specific batch
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [GrowthMeasurement])
  async batchGrowthHistory(
    @CurrentTenant() tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<readonly GrowthMeasurement[]> {
    const result = (await this.queryBus.execute(
      new GetGrowthMeasurementsQuery(
        tenantId,
        { batchId },
        1,
        limit ?? 50,
        'measurementDate',
        'DESC',
      ),
    )) as PaginatedQueryResult<GrowthMeasurement>;
    return fromCqrsPaginated(result).items;
  }

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  /**
   * Record a new growth sample
   */
  // SSOT-H-18: a new growth sample changes the growthAnalysis result; evict its
  // 2h cache (otherwise never invalidated) so the analysis isn't stale.
  @CacheEvict({ prefixes: ['growth:analysis'] })
  @Mutation(() => GrowthMeasurement)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async recordGrowthSample(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: RecordGrowthSampleInput,
  ): Promise<GrowthMeasurement> {
    return this.commandBus.execute(
      new RecordGrowthSampleCommand(
        tenantId,
        {
          batchId: input.batchId,
          tankId: input.tankId,
          measurementDate: input.measurementDate,
          measurementType: input.measurementType,
          measurementMethod: input.measurementMethod,
          populationSize: input.populationSize,
          individualMeasurements: input.individualMeasurements as IndividualMeasurement[],
          conditions: input.conditions as MeasurementConditions | undefined,
          measuredBy: input.measuredBy,
          notes: input.notes,
          updateBatchWeight: input.updateBatchWeight,
        },
        userId,
      ),
    );
  }

  /**
   * Update batch weight from a sample measurement
   */
  @Mutation(() => GrowthMeasurement)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateBatchWeightFromSample(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('measurementId', { type: () => ID }) measurementId: string,
  ): Promise<GrowthMeasurement> {
    return this.commandBus.execute(
      new UpdateBatchWeightFromSampleCommand(tenantId, batchId, measurementId, userId),
    );
  }

  /**
   * Verify a measurement
   */
  // SSOT-H-18: verifying a measurement changes which samples feed growthAnalysis; evict.
  @CacheEvict({ prefixes: ['growth:analysis'] })
  @Mutation(() => GrowthMeasurement)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async verifyMeasurement(
    @CurrentTenant() tenantId: string,
    @Args('measurementId', { type: () => ID }) measurementId: string,
    @CurrentUser('sub') userId: string,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<GrowthMeasurement> {
    return this.commandBus.execute(
      new VerifyMeasurementCommand(tenantId, measurementId, userId, notes),
    );
  }

  // ==========================================================================
  // FIELD RESOLVERS
  // ==========================================================================

  /**
   * Calculate sample percentage
   */
  @ResolveField(() => Float)
  samplePercent(@Parent() measurement: GrowthMeasurement): number {
    if (measurement.populationSize <= 0) return 0;
    return (measurement.sampleSize / measurement.populationSize) * 100;
  }

  /**
   * Check if growth is uniform (CV < 20%)
   */
  @ResolveField(() => Boolean)
  isUniformGrowth(@Parent() measurement: GrowthMeasurement): boolean {
    return measurement.weightCV <= 20;
  }

  /**
   * Check if grading is needed (CV > 25%)
   */
  @ResolveField(() => Boolean)
  needsGrading(@Parent() measurement: GrowthMeasurement): boolean {
    return measurement.weightCV > 25;
  }

  /**
   * Check if growth is on target
   */
  @ResolveField(() => Boolean)
  isOnTarget(@Parent() measurement: GrowthMeasurement): boolean {
    if (!measurement.growthComparison) return true;
    return Math.abs(measurement.growthComparison.variancePercent) <= 10;
  }

  /**
   * Check if FCR is on target
   */
  @ResolveField(() => Boolean)
  isFCROnTarget(@Parent() measurement: GrowthMeasurement): boolean {
    if (!measurement.fcrAnalysis) return true;
    return Math.abs(measurement.fcrAnalysis.fcrVariance) <= 10;
  }

  /**
   * Get weight statistics min value
   */
  @ResolveField(() => Float)
  minWeight(@Parent() measurement: GrowthMeasurement): number {
    return measurement.statistics?.weight?.min ?? 0;
  }

  /**
   * Get weight statistics max value
   */
  @ResolveField(() => Float)
  maxWeight(@Parent() measurement: GrowthMeasurement): number {
    return measurement.statistics?.weight?.max ?? 0;
  }

  /**
   * Get weight statistics median
   */
  @ResolveField(() => Float)
  medianWeight(@Parent() measurement: GrowthMeasurement): number {
    return measurement.statistics?.weight?.median ?? 0;
  }

  /**
   * Get weight statistics standard deviation
   */
  @ResolveField(() => Float)
  weightStdDev(@Parent() measurement: GrowthMeasurement): number {
    return measurement.statistics?.weight?.stdDev ?? 0;
  }

  /**
   * Get weight range
   */
  @ResolveField(() => Float)
  weightRange(@Parent() measurement: GrowthMeasurement): number {
    const stats = measurement.statistics?.weight;
    if (!stats) return 0;
    return stats.max - stats.min;
  }

  /**
   * Get daily growth rate (ADG)
   */
  @ResolveField(() => Float, { nullable: true })
  dailyGrowthRate(@Parent() measurement: GrowthMeasurement): number | null {
    return measurement.growthComparison?.dailyGrowthRate ?? null;
  }

  /**
   * Get specific growth rate (SGR)
   */
  @ResolveField(() => Float, { nullable: true })
  specificGrowthRate(@Parent() measurement: GrowthMeasurement): number | null {
    return measurement.growthComparison?.specificGrowthRate ?? null;
  }

  /**
   * Get period FCR
   */
  @ResolveField(() => Float, { nullable: true })
  periodFCR(@Parent() measurement: GrowthMeasurement): number | null {
    return measurement.fcrAnalysis?.periodFCR ?? null;
  }

  /**
   * Get cumulative FCR
   */
  @ResolveField(() => Float, { nullable: true })
  cumulativeFCR(@Parent() measurement: GrowthMeasurement): number | null {
    return measurement.fcrAnalysis?.cumulativeFCR ?? null;
  }

  /**
   * Get FCR trend
   */
  @ResolveField(() => String, { nullable: true })
  fcrTrend(@Parent() measurement: GrowthMeasurement): string | null {
    return measurement.fcrAnalysis?.fcrTrend ?? null;
  }

  /**
   * Has high priority actions
   */
  @ResolveField(() => Boolean)
  hasHighPriorityActions(@Parent() measurement: GrowthMeasurement): boolean {
    return measurement.suggestedActions?.priority === 'high';
  }

  /**
   * Get action count
   */
  @ResolveField(() => Int)
  actionCount(@Parent() measurement: GrowthMeasurement): number {
    return measurement.suggestedActions?.actions?.length ?? 0;
  }
}
