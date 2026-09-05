/**
 * Feeding GraphQL Resolver
 *
 * Yemleme operasyonları için GraphQL API.
 * CQRS pattern ile CommandBus ve QueryBus kullanır.
 *
 * @module Feeding/Resolvers
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
  registerEnumType,
} from '@nestjs/graphql';
import { IsOptional, IsUUID, IsNumber, IsPositive, IsInt, Min, IsArray, IsDate, IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import { Roles, Role, CurrentTenant, CurrentUser } from '@aquaculture/backend-common/decorators';
import { StandardPaginationInput, StandardPaginatedResponse, fromCqrsPaginated, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { getTenantSchemaName } from '../../common/utils/schema-sanitizer';
import GraphQLJSON from 'graphql-type-json';

// Entities
import { FeedingRecord, FeedingMethod, FishAppetite, FeedingEnvironment, FishBehavior } from '../entities/feeding-record.entity';

// Commands
import { CreateFeedingRecordCommand } from '../commands/create-feeding-record.command';
import { UpdateFeedingRecordCommand } from '../commands/update-feeding-record.command';

// Queries
import { GetFeedingRecordsQuery } from '../queries/get-feeding-records.query';
import { GetDailyFeedingPlanQuery } from '../queries/get-daily-feeding-plan.query';
import { GetFeedingSummaryQuery, FeedingSummaryResult } from '../queries/get-feeding-summary.query';

// Services
import { GrowthSimulatorService, GrowthSimulationResult } from '../services/growth-simulator.service';

// ============================================================================
// ENUM REGISTRATIONS
// ============================================================================

// ============================================================================
// INPUT TYPES
// ============================================================================

/**
 * Feeding environment conditions recorded during a feeding event.
 */
@InputType()
export class FeedingEnvironmentInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  waterTemp?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  dissolvedOxygen?: number;

  @Field({ nullable: true })
  @IsOptional()
  weather?: string;

  @Field({ nullable: true })
  @IsOptional()
  windLevel?: string;

  @Field({ nullable: true })
  @IsOptional()
  visibility?: string;
}

/**
 * Fish behavior observations during a feeding event.
 */
@InputType()
export class FishBehaviorInput {
  @Field(() => FishAppetite)
  @IsEnum(FishAppetite)
  appetite!: FishAppetite;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  feedingIntensity!: number;

  @Field({ nullable: true })
  @IsOptional()
  surfaceActivity?: string;

  @Field({ nullable: true })
  @IsOptional()
  schoolingBehavior?: string;

  @Field({ nullable: true })
  @IsOptional()
  abnormalBehavior?: string;
}

/**
 * Input type for creating a new feeding record.
 * Every field carries at least one class-validator decorator so that the
 * global ValidationPipe (whitelist + forbidNonWhitelisted) accepts them.
 */
@InputType()
export class CreateFeedingRecordInput {
  @Field(() => ID)
  @IsUUID()
  batchId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field()
  @IsDate()
  feedingDate!: Date;

  @Field()
  @IsNotEmpty()
  @IsString()
  feedingTime!: string;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  feedingSequence!: number;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  totalMealsToday!: number;

  @Field(() => ID)
  @IsUUID()
  feedId!: string;

  @Field({ nullable: true })
  @IsOptional()
  feedBatchNumber?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  plannedAmount!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  actualAmount!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  wasteAmount?: number;

  @Field(() => FeedingEnvironmentInput, { nullable: true })
  @IsOptional()
  environment?: FeedingEnvironmentInput;

  @Field(() => FishBehaviorInput, { nullable: true })
  @IsOptional()
  fishBehavior?: FishBehaviorInput;

  @Field(() => FeedingMethod, { defaultValue: FeedingMethod.MANUAL })
  @IsOptional()
  @IsEnum(FeedingMethod)
  feedingMethod!: FeedingMethod;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  feedingDurationMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  feedCost?: number;

  @Field({ nullable: true })
  @IsOptional()
  currency?: string;

  @Field(() => ID)
  @IsUUID()
  fedBy!: string;

  @Field({ nullable: true })
  @IsOptional()
  notes?: string;

  @Field({ nullable: true })
  @IsOptional()
  skipReason?: string;
}

/**
 * Input type for updating an existing feeding record.
 */
@InputType()
export class UpdateFeedingRecordInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  actualAmount?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  wasteAmount?: number;

  @Field(() => FeedingEnvironmentInput, { nullable: true })
  @IsOptional()
  environment?: FeedingEnvironmentInput;

  @Field(() => FishBehaviorInput, { nullable: true })
  @IsOptional()
  fishBehavior?: FishBehaviorInput;

  @Field({ nullable: true })
  @IsOptional()
  notes?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  verifiedBy?: string;
}

/**
 * Filter input for feeding record queries.
 */
@InputType()
export class FeedingRecordFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  feedId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  startDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  endDate?: Date;

  @Field(() => FeedingMethod, { nullable: true })
  @IsOptional()
  @IsEnum(FeedingMethod)
  feedingMethod?: FeedingMethod;

  @Field({ nullable: true })
  @IsOptional()
  appetite?: string;

  @Field({ nullable: true })
  @IsOptional()
  fedBy?: string;

  @Field({ nullable: true })
  @IsOptional()
  hasVariance?: boolean;
}

@InputType('FeedingPaginationInput')
export class FeedingPaginationInput extends StandardPaginationInput {}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class DailyFeedingPlanResponse {
  @Field()
  date!: Date;

  @Field(() => ID)
  siteId!: string;

  @Field(() => [PlannedFeeding])
  plannedFeedings!: PlannedFeeding[];

  @Field(() => Float)
  totalPlannedKg!: number;

  @Field(() => Float)
  totalActualKg!: number;

  @Field(() => Float)
  completionPercent!: number;
}

@ObjectType()
export class PlannedFeeding {
  @Field(() => ID)
  batchId!: string;

  @Field()
  batchCode!: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field({ nullable: true })
  tankCode?: string;

  @Field(() => ID)
  feedId!: string;

  @Field()
  feedName!: string;

  @Field(() => Float)
  plannedAmountKg!: number;

  @Field(() => Float)
  actualAmountKg!: number;

  @Field(() => Int)
  mealsPlanned!: number;

  @Field(() => Int)
  mealsCompleted!: number;

  @Field()
  isComplete!: boolean;
}

@ObjectType()
export class FeedingSummaryResponse {
  @Field(() => ID, { nullable: true })
  batchId?: string;

  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field()
  startDate!: Date;

  @Field()
  endDate!: Date;

  @Field(() => Float)
  totalFeedGivenKg!: number;

  @Field(() => Float)
  totalPlannedKg!: number;

  @Field(() => Float)
  varianceKg!: number;

  @Field(() => Float)
  variancePercent!: number;

  @Field(() => Int)
  totalFeedings!: number;

  @Field(() => Float)
  avgFeedingKg!: number;

  @Field(() => Float, {
    deprecationReason: 'Use totalCostDecimal (exact decimal string, ADR-0004).',
  })
  totalCost!: number;


  /** Exact-decimal wire form of `totalCost` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar)
  totalCostDecimal!: number;

  @Field({ nullable: true })
  currency?: string;

  @Field(() => [FeedTypeSummary])
  byFeedType!: FeedTypeSummary[];
}

@ObjectType()
export class FeedTypeSummary {
  @Field(() => ID)
  feedId!: string;

  @Field()
  feedName!: string;

  @Field(() => Float)
  totalKg!: number;

  @Field(() => Float)
  percentage!: number;

  @Field(() => Float, {
    deprecationReason: 'Use costDecimal (exact decimal string, ADR-0004).',
  })
  cost!: number;

  /** Exact-decimal wire form of `cost` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar)
  costDecimal!: number;
}

@ObjectType()
export class FeedingRecordConnection extends StandardPaginatedResponse(FeedingRecord) {}


// ============================================================================
// GROWTH SIMULATION TYPES
// ============================================================================

@InputType()
export class GrowthSimulationInput {
  @Field(() => ID, { nullable: true, description: 'Tank ID - preferred for tank-based simulation' })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true, description: 'Batch ID - legacy batch-based simulation' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => Float, { description: 'Current average weight in grams' })
  @IsNumber()
  @IsPositive()
  currentWeightG!: number;

  @Field(() => Int, { description: 'Current fish count' })
  @IsInt()
  @Min(1)
  currentCount!: number;

  @Field(() => Float, { description: 'Daily Specific Growth Rate (%)' })
  @IsNumber()
  @IsPositive()
  sgr!: number;

  @Field(() => Int, { description: 'Number of days to project' })
  @IsInt()
  @Min(1)
  projectionDays!: number;

  @Field(() => Float, { nullable: true, description: 'Daily mortality rate (default 0.01%)' })
  @IsOptional()
  @IsNumber()
  mortalityRate?: number;

  @Field(() => [Float], { nullable: true, description: 'Optional daily temperature forecast' })
  @IsOptional()
  @IsArray()
  temperatureForecast?: number[];

  @Field({ nullable: true, description: 'Projection start date' })
  @IsOptional()
  startDate?: Date;
}

@ObjectType()
export class GrowthProjectionResponse {
  @Field(() => Int)
  day!: number;

  @Field()
  date!: Date;

  @Field(() => Float)
  avgWeightG!: number;

  @Field(() => Int)
  fishCount!: number;

  @Field(() => Float)
  biomassKg!: number;

  @Field(() => Float)
  sgr!: number;

  @Field({ nullable: true })
  feedCode?: string;

  @Field({ nullable: true })
  feedName?: string;

  @Field(() => Float)
  feedingRatePercent!: number;

  @Field(() => Float)
  dailyFeedKg!: number;

  @Field(() => Float)
  cumulativeFeedKg!: number;

  @Field(() => Float, { nullable: true })
  fcr?: number;

  @Field(() => Float, { nullable: true })
  temperature?: number;

  @Field(() => Int)
  mortality!: number;

  @Field(() => Int)
  cumulativeMortality!: number;
}

@ObjectType()
export class GrowthSimulationSummary {
  @Field(() => Float)
  startWeight!: number;

  @Field(() => Float)
  endWeight!: number;

  @Field(() => Float)
  startBiomass!: number;

  @Field(() => Float)
  endBiomass!: number;

  @Field(() => Float)
  totalFeedKg!: number;

  @Field(() => Float)
  avgFCR!: number;

  @Field(() => Int)
  totalMortality!: number;

  @Field({ nullable: true })
  harvestDate?: Date;

  @Field(() => Float, { nullable: true })
  harvestWeight?: number;
}

@ObjectType()
export class FeedRequirementResponse {
  @Field()
  feedCode!: string;

  @Field()
  feedName!: string;

  @Field(() => Float)
  totalKg!: number;

  @Field(() => Int)
  daysUsed!: number;

  @Field(() => Int)
  startDay!: number;

  @Field(() => Int)
  endDay!: number;
}

@ObjectType()
export class GrowthSimulationResponse {
  @Field(() => [GrowthProjectionResponse])
  projections!: GrowthProjectionResponse[];

  @Field(() => GrowthSimulationSummary)
  summary!: GrowthSimulationSummary;

  @Field(() => [FeedRequirementResponse])
  feedRequirements!: FeedRequirementResponse[];
}

// ============================================================================
// ACTIVE TANKS TYPES
// ============================================================================

@ObjectType()
export class ActiveTankResponse {
  @Field(() => ID)
  tankId!: string;

  @Field({ nullable: true })
  tankName?: string;

  @Field({ nullable: true })
  tankCode?: string;

  @Field(() => ID, { nullable: true })
  batchId?: string;

  @Field({ nullable: true })
  batchNumber?: string;

  @Field(() => Int)
  fishCount!: number;

  @Field(() => Float)
  avgWeightG!: number;

  @Field(() => Float)
  biomassKg!: number;
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => FeedingRecord)
export class FeedingResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly growthSimulator: GrowthSimulatorService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get feeding record by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedingRecord, { nullable: true })
  async feedingRecord(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<FeedingRecord | null> {
    // Fail-closed tenant boundary: a lost pooled-connection search_path must
    // raise, not silently resolve the wrong schema for a single-record read.
    return runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      queryRunner.manager.findOne(FeedingRecord, {
        where: { id, tenantId },
        relations: ['batch', 'feed', 'tank'],
      }),
    );
  }

  /**
   * List feeding records with filters
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedingRecordConnection)
  async feedingRecords(
    @CurrentTenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: FeedingRecordFilterInput,
    @Args('pagination', { nullable: true }) pagination?: FeedingPaginationInput,
  ): Promise<IStandardPaginatedResult<FeedingRecord>> {
    const result: PaginatedQueryResult<FeedingRecord> = await this.queryBus.execute(
      new GetFeedingRecordsQuery(
        tenantId,
        {
          batchId: filter?.batchId,
          tankId: filter?.tankId,
          feedId: filter?.feedId,
          fromDate: filter?.startDate,
          toDate: filter?.endDate,
          feedingMethod: filter?.feedingMethod ? [filter.feedingMethod] : undefined,
          appetite: filter?.appetite ? [filter.appetite as FishAppetite] : undefined,
          fedBy: filter?.fedBy,
          hasVariance: filter?.hasVariance,
        },
        pagination?.page ?? 1,
        pagination?.limit ?? 20,
      ),
    );
    return fromCqrsPaginated(result);
  }

  /**
   * Get daily feeding plan for a site.
   *
   * The date argument is explicitly typed as Date (maps to the DateTime scalar)
   * so that the federated schema exposes `date: DateTime` and matches the
   * frontend variable declaration `$date: DateTime`.  Without the explicit
   * `type` option NestJS may fall back to `String`, causing an HTTP 400 when
   * the gateway validates the incoming query against the composed supergraph.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => DailyFeedingPlanResponse)
  async dailyFeedingPlan(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('date', { type: () => Date, nullable: true }) date?: Date,
  ): Promise<DailyFeedingPlanResponse> {
    return this.queryBus.execute(
      new GetDailyFeedingPlanQuery(tenantId, siteId, date || new Date()),
    );
  }

  /**
   * Get feeding summary/statistics
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedingSummaryResponse)
  async feedingSummary(
    @CurrentTenant() tenantId: string,
    @Args('entityType') entityType: 'batch' | 'tank',
    @Args('entityId', { type: () => ID }) entityId: string,
    @Args('startDate', { nullable: true }) startDate?: Date,
    @Args('endDate', { nullable: true }) endDate?: Date,
  ): Promise<FeedingSummaryResponse> {
    // Map the flat handler Result onto the GraphQL Response shape. Returning the
    // handler result unmapped left every non-nullable @Field (startDate/endDate,
    // totalFeedGivenKg, byFeedType…) absent → "Cannot return null for
    // non-nullable field" and a dead feeding-summary tab.
    const result: FeedingSummaryResult = await this.queryBus.execute(
      new GetFeedingSummaryQuery(tenantId, entityType, entityId, startDate, endDate),
    );
    return this.toFeedingSummaryResponse(result);
  }

  private toFeedingSummaryResponse(result: FeedingSummaryResult): FeedingSummaryResponse {
    return {
      batchId: result.entityType === 'batch' ? result.entityId : undefined,
      // The summary is entity-scoped (batch|tank); the result carries no siteId.
      siteId: undefined,
      startDate: result.startDate,
      endDate: result.endDate,
      totalFeedGivenKg: result.totalActualKg,
      totalPlannedKg: result.totalPlannedKg,
      varianceKg: result.totalVarianceKg,
      variancePercent: result.avgVariancePercent,
      totalFeedings: result.totalFeedingsCount,
      avgFeedingKg: result.avgDailyFeedingKg,
      totalCost: result.totalFeedCost,
      totalCostDecimal: result.totalFeedCost,
      currency: undefined,
      byFeedType: result.feedTypeDistribution.map((feedType) => ({
        feedId: feedType.feedId,
        feedName: feedType.feedName,
        totalKg: feedType.totalKg,
        percentage: feedType.percentage,
        cost: feedType.cost,
        costDecimal: feedType.cost,
      })),
    };
  }

  /**
   * Simulate growth for a tank, batch, or manual input
   * Projects fish growth over time using SGR formula
   * Tank-based simulation is preferred for per-tank feed management
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => GrowthSimulationResponse, { description: 'Simulate fish growth and feed requirements' })
  async growthSimulation(
    @CurrentTenant() tenantId: string,
    @Args('input') input: GrowthSimulationInput,
  ): Promise<GrowthSimulationResponse> {
    const schemaName = getTenantSchemaName(tenantId);
    const result = await this.growthSimulator.simulateGrowth({
      tenantId,
      schemaName,
      tankId: input.tankId,
      batchId: input.batchId,
      currentWeightG: input.currentWeightG,
      currentCount: input.currentCount,
      sgr: input.sgr,
      projectionDays: input.projectionDays,
      mortalityRate: input.mortalityRate,
      temperatureForecast: input.temperatureForecast,
      startDate: input.startDate,
    });

    return {
      projections: result.projections,
      summary: result.summary,
      feedRequirements: result.feedRequirements,
    };
  }

  /**
   * Calculate recommended harvest date based on target weight
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => Date, { description: 'Project harvest date for target weight' })
  async projectHarvestDate(
    @Args('currentWeightG', { type: () => Float }) currentWeightG: number,
    @Args('targetWeightG', { type: () => Float }) targetWeightG: number,
    @Args('sgr', { type: () => Float }) sgr: number,
    @Args('startDate', { nullable: true }) startDate?: Date,
  ): Promise<Date> {
    const result = this.growthSimulator.projectHarvestDate(
      currentWeightG,
      targetWeightG,
      sgr,
      startDate,
    );
    return result.harvestDate;
  }

  /**
   * Estimate SGR based on species and temperature
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => Float, { description: 'Estimate SGR for species at temperature' })
  estimateSGR(
    @Args('species') species: string,
    @Args('temperature', { type: () => Float }) temperature: number,
  ): number {
    return this.growthSimulator.estimateSGR(species, temperature);
  }

  /**
   * Get all active tanks with fish
   * Returns tanks that have fish (totalQuantity > 0) for tank selection in UI
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ActiveTankResponse], { description: 'Get all active tanks with fish for simulation' })
  async activeTanks(
    @CurrentTenant() tenantId: string,
  ): Promise<ActiveTankResponse[]> {
    const tanks = await this.growthSimulator.getActiveTanks(tenantId);
    return tanks.map(t => ({
      tankId: t.tankId,
      tankName: t.tankName,
      tankCode: t.tankCode,
      batchId: t.batchId,
      batchNumber: t.batchNumber,
      fishCount: t.fishCount,
      avgWeightG: t.avgWeightG,
      biomassKg: t.biomassKg,
    }));
  }

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  /**
   * Create a new feeding record
   */
  @Mutation(() => FeedingRecord)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createFeedingRecord(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: CreateFeedingRecordInput,
  ): Promise<FeedingRecord> {
    return this.commandBus.execute(
      new CreateFeedingRecordCommand(
        tenantId,
        {
          batchId: input.batchId,
          tankId: input.tankId,
          feedingDate: input.feedingDate,
          feedingTime: input.feedingTime,
          feedingSequence: input.feedingSequence,
          totalMealsToday: input.totalMealsToday,
          feedId: input.feedId,
          feedBatchNumber: input.feedBatchNumber,
          plannedAmount: input.plannedAmount,
          actualAmount: input.actualAmount,
          wasteAmount: input.wasteAmount,
          environment: input.environment as FeedingEnvironment | undefined,
          fishBehavior: input.fishBehavior as FishBehavior | undefined,
          feedingMethod: input.feedingMethod,
          equipmentId: input.equipmentId,
          feedingDurationMinutes: input.feedingDurationMinutes,
          feedCost: input.feedCost,
          currency: input.currency,
          fedBy: input.fedBy,
          notes: input.notes,
          skipReason: input.skipReason,
        },
        userId,
      ),
    );
  }

  /**
   * Update a feeding record
   */
  @Mutation(() => FeedingRecord)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateFeedingRecord(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: UpdateFeedingRecordInput,
  ): Promise<FeedingRecord> {
    return this.commandBus.execute(
      new UpdateFeedingRecordCommand(
        tenantId,
        id,
        {
          actualAmount: input.actualAmount,
          wasteAmount: input.wasteAmount,
          environment: input.environment as FeedingEnvironment | undefined,
          fishBehavior: input.fishBehavior as FishBehavior | undefined,
          notes: input.notes,
        },
        userId,
      ),
    );
  }

  // ==========================================================================
  // FIELD RESOLVERS
  // ==========================================================================

  /**
   * Calculate variance for feeding record
   */
  @ResolveField(() => Float)
  variance(@Parent() record: FeedingRecord): number {
    return Number(record.actualAmount) - Number(record.plannedAmount);
  }

  /**
   * Calculate variance percent
   */
  @ResolveField(() => Float)
  variancePercent(@Parent() record: FeedingRecord): number {
    const planned = Number(record.plannedAmount);
    if (planned <= 0) return 0;
    const variance = Number(record.actualAmount) - planned;
    return (variance / planned) * 100;
  }

  /**
   * Is feeding below plan
   */
  @ResolveField(() => Boolean, { description: 'Whether actual amount is below planned' })
  isBelowPlan(@Parent() record: FeedingRecord): boolean {
    return Number(record.variance) < 0;
  }

  /**
   * Is variance acceptable (within ±10%)
   */
  @ResolveField(() => Boolean, { description: 'Whether variance is within acceptable threshold (±10%)' })
  isVarianceAcceptable(@Parent() record: FeedingRecord): boolean {
    return Math.abs(Number(record.variancePercent)) <= 10;
  }
}

