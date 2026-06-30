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
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Roles, Role, CurrentTenant, CurrentUser } from '@aquaculture/backend-common/decorators';
import { StandardPaginationInput, StandardPaginatedResponse, fromCqrsPaginated, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { getTenantSchemaName } from '../../common/utils/schema-sanitizer';
import GraphQLJSON from 'graphql-type-json';

// Entities
import { FeedingRecord, FeedingMethod, FishAppetite, FeedingEnvironment, FishBehavior } from '../entities/feeding-record.entity';
import { FeedInventory, InventoryStatus, InventoryMovementType } from '../entities/feed-inventory.entity';

// Commands
import { CreateFeedingRecordCommand } from '../commands/create-feeding-record.command';
import { UpdateFeedingRecordCommand } from '../commands/update-feeding-record.command';
import { AddFeedInventoryCommand } from '../commands/add-feed-inventory.command';
import { ConsumeFeedInventoryCommand, ConsumptionReason } from '../commands/consume-feed-inventory.command';
import { AdjustFeedInventoryCommand, AdjustmentType } from '../commands/adjust-feed-inventory.command';

// Queries
import { GetFeedingRecordsQuery } from '../queries/get-feeding-records.query';
import { GetDailyFeedingPlanQuery } from '../queries/get-daily-feeding-plan.query';
import { GetFeedInventoryQuery } from '../queries/get-feed-inventory.query';
import { GetFeedingSummaryQuery, FeedingSummaryResult } from '../queries/get-feeding-summary.query';

// Services
import { GrowthSimulatorService, GrowthSimulationResult } from '../services/growth-simulator.service';
import { FeedConsumptionForecastService, FeedForecastSummary } from '../services/feed-consumption-forecast.service';

// ============================================================================
// ENUM REGISTRATIONS
// ============================================================================

registerEnumType(ConsumptionReason, {
  name: 'ConsumptionReason',
  description: 'Yem tüketim nedeni',
});

registerEnumType(AdjustmentType, {
  name: 'AdjustmentType',
  description: 'Stok düzeltme tipi',
});

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
  appetite: FishAppetite;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  feedingIntensity: number;

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
  batchId: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field()
  @IsDate()
  feedingDate: Date;

  @Field()
  @IsNotEmpty()
  @IsString()
  feedingTime: string;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  feedingSequence: number;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  totalMealsToday: number;

  @Field(() => ID)
  @IsUUID()
  feedId: string;

  @Field({ nullable: true })
  @IsOptional()
  feedBatchNumber?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  plannedAmount: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  actualAmount: number;

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
  feedingMethod: FeedingMethod;

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
  fedBy: string;

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
 * Input type for adding feed inventory (purchase / stock-in).
 * Every field carries at least one class-validator decorator so that the
 * global ValidationPipe (whitelist + forbidNonWhitelisted) accepts them.
 */
@InputType()
export class AddFeedInventoryInput {
  @Field(() => ID)
  @IsUUID()
  feedId: string;

  @Field(() => ID)
  @IsUUID()
  siteId: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.001)
  quantityKg: number;

  @Field({ nullable: true })
  @IsOptional()
  lotNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  manufacturingDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  expiryDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  receivedDate?: Date;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPricePerKg?: number;

  @Field({ nullable: true })
  @IsOptional()
  currency?: string;

  @Field({ nullable: true })
  @IsOptional()
  storageLocation?: string;

  @Field({ nullable: true })
  @IsOptional()
  notes?: string;

  @Field(() => ID)
  @IsUUID()
  createdBy: string;
}

/**
 * Input type for consuming feed from inventory (usage / feeding).
 */
@InputType()
export class ConsumeFeedInventoryInput {
  @Field(() => ID)
  @IsUUID()
  inventoryId: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.001)
  quantityKg: number;

  @Field(() => ConsumptionReason, { defaultValue: ConsumptionReason.FEEDING })
  @IsOptional()
  @IsEnum(ConsumptionReason)
  reason: ConsumptionReason;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  feedingRecordId?: string;

  @Field({ nullable: true })
  @IsOptional()
  notes?: string;
}

/**
 * Input type for adjusting feed inventory (correction / audit).
 */
@InputType()
export class AdjustFeedInventoryInput {
  @Field(() => ID)
  @IsUUID()
  inventoryId: string;

  @Field(() => AdjustmentType)
  @IsEnum(AdjustmentType)
  adjustmentType: AdjustmentType;

  @Field(() => Float)
  @IsNumber()
  @IsPositive()
  quantity: number;

  /** Human-readable reason for the adjustment. */
  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  reason: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  notes?: string;
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

/**
 * Filter input for feed inventory queries.
 */
@InputType()
export class FeedInventoryFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  feedId?: string;

  @Field(() => InventoryStatus, { nullable: true })
  @IsOptional()
  @IsEnum(InventoryStatus)
  status?: InventoryStatus;

  @Field({ nullable: true })
  @IsOptional()
  includeLowStock?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  includeExpiringSoon?: boolean;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

@InputType('FeedingPaginationInput')
export class FeedingPaginationInput extends StandardPaginationInput {}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class DailyFeedingPlanResponse {
  @Field()
  date: Date;

  @Field(() => ID)
  siteId: string;

  @Field(() => [PlannedFeeding])
  plannedFeedings: PlannedFeeding[];

  @Field(() => Float)
  totalPlannedKg: number;

  @Field(() => Float)
  totalActualKg: number;

  @Field(() => Float)
  completionPercent: number;
}

@ObjectType()
export class PlannedFeeding {
  @Field(() => ID)
  batchId: string;

  @Field()
  batchCode: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field({ nullable: true })
  tankCode?: string;

  @Field(() => ID)
  feedId: string;

  @Field()
  feedName: string;

  @Field(() => Float)
  plannedAmountKg: number;

  @Field(() => Float)
  actualAmountKg: number;

  @Field(() => Int)
  mealsPlanned: number;

  @Field(() => Int)
  mealsCompleted: number;

  @Field()
  isComplete: boolean;
}

@ObjectType()
export class FeedingSummaryResponse {
  @Field(() => ID, { nullable: true })
  batchId?: string;

  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field()
  startDate: Date;

  @Field()
  endDate: Date;

  @Field(() => Float)
  totalFeedGivenKg: number;

  @Field(() => Float)
  totalPlannedKg: number;

  @Field(() => Float)
  varianceKg: number;

  @Field(() => Float)
  variancePercent: number;

  @Field(() => Int)
  totalFeedings: number;

  @Field(() => Float)
  avgFeedingKg: number;

  @Field(() => Float)
  totalCost: number;

  @Field({ nullable: true })
  currency?: string;

  @Field(() => [FeedTypeSummary])
  byFeedType: FeedTypeSummary[];
}

@ObjectType()
export class FeedTypeSummary {
  @Field(() => ID)
  feedId: string;

  @Field()
  feedName: string;

  @Field(() => Float)
  totalKg: number;

  @Field(() => Float)
  percentage: number;

  @Field(() => Float)
  cost: number;
}

@ObjectType()
export class FeedingRecordConnection extends StandardPaginatedResponse(FeedingRecord) {}

@ObjectType()
export class FeedInventoryConnection extends StandardPaginatedResponse(FeedInventory) {}

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
  currentWeightG: number;

  @Field(() => Int, { description: 'Current fish count' })
  @IsInt()
  @Min(1)
  currentCount: number;

  @Field(() => Float, { description: 'Daily Specific Growth Rate (%)' })
  @IsNumber()
  @IsPositive()
  sgr: number;

  @Field(() => Int, { description: 'Number of days to project' })
  @IsInt()
  @Min(1)
  projectionDays: number;

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
  day: number;

  @Field()
  date: Date;

  @Field(() => Float)
  avgWeightG: number;

  @Field(() => Int)
  fishCount: number;

  @Field(() => Float)
  biomassKg: number;

  @Field(() => Float)
  sgr: number;

  @Field({ nullable: true })
  feedCode?: string;

  @Field({ nullable: true })
  feedName?: string;

  @Field(() => Float)
  feedingRatePercent: number;

  @Field(() => Float)
  dailyFeedKg: number;

  @Field(() => Float)
  cumulativeFeedKg: number;

  @Field(() => Float, { nullable: true })
  fcr?: number;

  @Field(() => Float, { nullable: true })
  temperature?: number;

  @Field(() => Int)
  mortality: number;

  @Field(() => Int)
  cumulativeMortality: number;
}

@ObjectType()
export class GrowthSimulationSummary {
  @Field(() => Float)
  startWeight: number;

  @Field(() => Float)
  endWeight: number;

  @Field(() => Float)
  startBiomass: number;

  @Field(() => Float)
  endBiomass: number;

  @Field(() => Float)
  totalFeedKg: number;

  @Field(() => Float)
  avgFCR: number;

  @Field(() => Int)
  totalMortality: number;

  @Field({ nullable: true })
  harvestDate?: Date;

  @Field(() => Float, { nullable: true })
  harvestWeight?: number;
}

@ObjectType()
export class FeedRequirementResponse {
  @Field()
  feedCode: string;

  @Field()
  feedName: string;

  @Field(() => Float)
  totalKg: number;

  @Field(() => Int)
  daysUsed: number;

  @Field(() => Int)
  startDay: number;

  @Field(() => Int)
  endDay: number;
}

@ObjectType()
export class GrowthSimulationResponse {
  @Field(() => [GrowthProjectionResponse])
  projections: GrowthProjectionResponse[];

  @Field(() => GrowthSimulationSummary)
  summary: GrowthSimulationSummary;

  @Field(() => [FeedRequirementResponse])
  feedRequirements: FeedRequirementResponse[];
}

// ============================================================================
// FEED CONSUMPTION FORECAST TYPES
// ============================================================================

@InputType()
export class FeedForecastInput {
  @Field(() => ID, { nullable: true, description: 'Filter by site' })
  siteId?: string;

  @Field(() => Int, { defaultValue: 30, description: 'Number of days to forecast' })
  forecastDays: number;

  @Field(() => Int, { nullable: true, description: 'Lead time before stockout to recommend reorder' })
  leadTimeDays?: number;

  @Field(() => Int, { nullable: true, description: 'Safety stock days to maintain' })
  safetyStockDays?: number;
}

@ObjectType()
export class FeedConsumptionBatchInfo {
  @Field(() => ID)
  batchId: string;

  @Field()
  batchCode: string;

  @Field(() => Float)
  consumption: number;
}

@ObjectType()
export class FeedConsumptionByTypeResponse {
  @Field(() => ID)
  feedId: string;

  @Field()
  feedCode: string;

  @Field()
  feedName: string;

  @Field(() => [Float])
  dailyConsumption: number[];

  @Field(() => Float)
  totalConsumption: number;

  @Field(() => Float)
  currentStock: number;

  @Field(() => Int)
  daysUntilStockout: number;

  @Field({ nullable: true })
  stockoutDate?: Date;

  @Field({ nullable: true })
  reorderDate?: Date;

  @Field(() => Float)
  reorderQuantity: number;

  @Field(() => [FeedConsumptionBatchInfo])
  batches: FeedConsumptionBatchInfo[];
}

@ObjectType()
export class FeedForecastAlert {
  @Field(() => ID)
  feedId: string;

  @Field()
  feedCode: string;

  @Field()
  type: string;

  @Field()
  message: string;

  @Field(() => Int)
  daysUntilStockout: number;
}

@ObjectType()
export class FeedForecastResponse {
  @Field(() => Int)
  forecastDays: number;

  @Field()
  startDate: Date;

  @Field()
  endDate: Date;

  @Field(() => [FeedConsumptionByTypeResponse])
  byFeedType: FeedConsumptionByTypeResponse[];

  @Field(() => [FeedForecastAlert])
  alerts: FeedForecastAlert[];

  @Field(() => Float)
  totalConsumption: number;

  @Field(() => Float)
  totalCurrentStock: number;
}

// ============================================================================
// ACTIVE TANKS TYPES
// ============================================================================

@ObjectType()
export class ActiveTankResponse {
  @Field(() => ID)
  tankId: string;

  @Field({ nullable: true })
  tankName?: string;

  @Field({ nullable: true })
  tankCode?: string;

  @Field(() => ID, { nullable: true })
  batchId?: string;

  @Field({ nullable: true })
  batchNumber?: string;

  @Field(() => Int)
  fishCount: number;

  @Field(() => Float)
  avgWeightG: number;

  @Field(() => Float)
  biomassKg: number;
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
    private readonly feedForecastService: FeedConsumptionForecastService,
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
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
    return this.feedingRecordRepository.findOne({
      where: { id, tenantId },
      relations: ['batch', 'feed', 'tank'],
    });
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
      currency: undefined,
      byFeedType: result.feedTypeDistribution.map((feedType) => ({
        feedId: feedType.feedId,
        feedName: feedType.feedName,
        totalKg: feedType.totalKg,
        percentage: feedType.percentage,
        cost: feedType.cost,
      })),
    };
  }

  /**
   * Get feed inventory
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedInventoryConnection)
  async feedInventory(
    @CurrentTenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: FeedInventoryFilterInput,
    @Args('pagination', { nullable: true }) pagination?: FeedingPaginationInput,
  ): Promise<IStandardPaginatedResult<FeedInventory>> {
    const result: PaginatedQueryResult<FeedInventory> = await this.queryBus.execute(
      new GetFeedInventoryQuery(
        tenantId,
        {
          siteId: filter?.siteId,
          feedId: filter?.feedId,
          departmentId: filter?.departmentId,
          status: filter?.status ? [filter.status] : undefined,
          lowStockOnly: filter?.includeLowStock,
          expiringWithinDays: filter?.includeExpiringSoon ? 30 : undefined,
        },
        pagination?.page ?? 1,
        pagination?.limit ?? 20,
      ),
    );
    return fromCqrsPaginated(result);
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
   * Forecast feed consumption across all active batches
   * Calculates stockout dates and reorder recommendations
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedForecastResponse, { description: 'Forecast feed consumption and stockout dates' })
  async feedConsumptionForecast(
    @CurrentTenant() tenantId: string,
    @Args('input', { nullable: true }) input?: FeedForecastInput,
  ): Promise<FeedForecastResponse> {
    const schemaName = getTenantSchemaName(tenantId);
    const result = await this.feedForecastService.forecastConsumption({
      tenantId,
      schemaName,
      siteId: input?.siteId,
      forecastDays: input?.forecastDays ?? 30,
      leadTimeDays: input?.leadTimeDays,
      safetyStockDays: input?.safetyStockDays,
    });

    return {
      forecastDays: result.forecastDays,
      startDate: result.startDate,
      endDate: result.endDate,
      byFeedType: result.byFeedType.map(f => ({
        feedId: f.feedId,
        feedCode: f.feedCode,
        feedName: f.feedName,
        dailyConsumption: f.dailyConsumption,
        totalConsumption: f.totalConsumption,
        currentStock: f.currentStock,
        daysUntilStockout: f.daysUntilStockout,
        stockoutDate: f.stockoutDate ?? undefined,
        reorderDate: f.reorderDate ?? undefined,
        reorderQuantity: f.reorderQuantity,
        batches: f.batches,
      })),
      alerts: result.alerts.map(a => ({
        feedId: a.feedId,
        feedCode: a.feedCode,
        type: a.type,
        message: a.message,
        daysUntilStockout: a.daysUntilStockout,
      })),
      totalConsumption: result.totalConsumption,
      totalCurrentStock: result.totalCurrentStock,
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

  /**
   * Add feed inventory
   */
  @Mutation(() => FeedInventory)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addFeedInventory(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: AddFeedInventoryInput,
  ): Promise<FeedInventory> {
    return this.commandBus.execute(
      new AddFeedInventoryCommand(
        tenantId,
        {
          feedId: input.feedId,
          siteId: input.siteId,
          departmentId: input.departmentId,
          quantityKg: input.quantityKg,
          lotNumber: input.lotNumber,
          manufacturingDate: input.manufacturingDate,
          expiryDate: input.expiryDate,
          receivedDate: input.receivedDate,
          unitPricePerKg: input.unitPricePerKg,
          currency: input.currency,
          storageLocation: input.storageLocation,
          notes: input.notes,
        },
        userId,
      ),
    );
  }

  /**
   * Consume feed from inventory
   */
  @Mutation(() => FeedInventory)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async consumeFeedInventory(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: ConsumeFeedInventoryInput,
  ): Promise<FeedInventory> {
    return this.commandBus.execute(
      new ConsumeFeedInventoryCommand(
        tenantId,
        {
          inventoryId: input.inventoryId,
          quantityKg: input.quantityKg,
          reason: input.reason,
          feedingRecordId: input.feedingRecordId,
          notes: input.notes,
        },
        userId,
      ),
    );
  }

  /**
   * Adjust feed inventory (correction)
   */
  @Mutation(() => FeedInventory)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async adjustFeedInventory(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: AdjustFeedInventoryInput,
  ): Promise<FeedInventory> {
    return this.commandBus.execute(
      new AdjustFeedInventoryCommand(
        tenantId,
        {
          inventoryId: input.inventoryId,
          adjustmentType: input.adjustmentType,
          quantity: input.quantity,
          reason: input.reason,
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

// ============================================================================
// FEED INVENTORY RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => FeedInventory)
export class FeedInventoryResolver {
  // ==========================================================================
  // FIELD RESOLVERS
  // ==========================================================================

  /**
   * Check if inventory is low stock
   */
  @ResolveField(() => Boolean)
  isLowStock(@Parent() inventory: FeedInventory): boolean {
    return Number(inventory.quantityKg) <= Number(inventory.minStockKg);
  }

  /**
   * Check if inventory is expired
   */
  @ResolveField(() => Boolean)
  isExpired(@Parent() inventory: FeedInventory): boolean {
    if (!inventory.expiryDate) return false;
    return new Date(inventory.expiryDate) < new Date();
  }

  /**
   * Days until expiry
   */
  @ResolveField(() => Int, { nullable: true })
  daysUntilExpiry(@Parent() inventory: FeedInventory): number | null {
    if (!inventory.expiryDate) return null;
    const now = new Date();
    const expiry = new Date(inventory.expiryDate);
    const diffTime = expiry.getTime() - now.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Calculate total value
   */
  @ResolveField(() => Float, { nullable: true })
  totalValue(@Parent() inventory: FeedInventory): number | null {
    if (!inventory.unitPricePerKg) return null;
    return Number(inventory.quantityKg) * Number(inventory.unitPricePerKg);
  }
}
