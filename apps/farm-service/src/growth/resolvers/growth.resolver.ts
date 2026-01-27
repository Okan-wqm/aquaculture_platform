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

@InputType()
export class IndividualMeasurementInput {
  @Field(() => Int)
  sampleNumber: number;

  @Field(() => Float)
  weight: number;

  @Field(() => Float, { nullable: true })
  length?: number;

  @Field(() => Float, { nullable: true })
  width?: number;

  @Field({ nullable: true })
  notes?: string;
}

@InputType()
export class MeasurementConditionsInput {
  @Field(() => Float, { nullable: true })
  waterTemp?: number;

  @Field(() => Float, { nullable: true })
  dissolvedOxygen?: number;

  @Field()
  feedingStatus: string;

  @Field()
  timeOfDay: string;

  @Field({ nullable: true })
  weatherConditions?: string;
}

@InputType()
export class RecordGrowthSampleInput {
  @Field(() => ID)
  batchId: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field()
  measurementDate: Date;

  @Field(() => MeasurementType, { defaultValue: MeasurementType.ROUTINE })
  measurementType: MeasurementType;

  @Field(() => MeasurementMethod, { defaultValue: MeasurementMethod.MANUAL_SCALE })
  measurementMethod: MeasurementMethod;

  @Field(() => Int)
  sampleSize: number;

  @Field(() => Int)
  populationSize: number;

  @Field(() => [IndividualMeasurementInput])
  individualMeasurements: IndividualMeasurementInput[];

  @Field(() => MeasurementConditionsInput, { nullable: true })
  conditions?: MeasurementConditionsInput;

  @Field(() => ID)
  measuredBy: string;

  @Field({ nullable: true })
  notes?: string;

  @Field({ defaultValue: true })
  updateBatchWeight: boolean;
}

@InputType()
export class GrowthMeasurementFilterInput {
  @Field(() => ID, { nullable: true })
  batchId?: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field(() => MeasurementType, { nullable: true })
  measurementType?: MeasurementType;

  @Field({ nullable: true })
  startDate?: Date;

  @Field({ nullable: true })
  endDate?: Date;

  @Field({ nullable: true })
  verifiedOnly?: boolean;
}

@InputType('GrowthPaginationInput')
export class GrowthPaginationInput {
  @Field(() => Int, { defaultValue: 0 })
  offset: number;

  @Field(() => Int, { defaultValue: 20 })
  limit: number;
}

// ============================================================================
// RESPONSE TYPES (Order matters - referenced types must be defined first)
// ============================================================================

// GrowthMetrics must be defined BEFORE GrowthAnalysisResponse to avoid
// "Cannot access 'X' before initialization" errors
@ObjectType()
export class GrowthMetrics {
  @Field(() => Float)
  currentAvgWeightG: number;

  @Field(() => Float)
  theoreticalWeightG: number;

  @Field(() => Float)
  weightVariancePercent: number;

  @Field(() => Float)
  currentBiomassKg: number;

  @Field(() => Int)
  currentQuantity: number;

  @Field(() => Float)
  survivalRate: number;

  @Field(() => Float)
  mortalityRate: number;

  @Field(() => Float)
  currentFCR: number;

  @Field(() => Float)
  targetFCR: number;

  @Field(() => Float)
  fcrVariancePercent: number;

  @Field(() => Float)
  dailyGrowthRateG: number;

  @Field(() => Float)
  specificGrowthRate: number;

  @Field(() => Float)
  weightCV: number;

  @Field(() => GrowthPerformance)
  performanceRating: GrowthPerformance;
}

@ObjectType()
export class GrowthTrend {
  @Field()
  direction: string;

  @Field(() => Float)
  avgDailyGrowthLast7Days: number;

  @Field(() => Float)
  avgDailyGrowthLast30Days: number;

  @Field(() => Float)
  growthAcceleration: number;

  @Field()
  fcrTrend: string;

  @Field(() => Float)
  fcrChangeLast7Days: number;
}

@ObjectType()
export class GrowthProjection {
  @Field(() => Float)
  projectedWeightIn30Days: number;

  @Field(() => Float)
  projectedBiomassIn30Days: number;

  @Field()
  estimatedHarvestDate: Date;

  @Field(() => Float)
  harvestTargetWeightG: number;

  @Field(() => Int)
  daysToHarvest: number;

  @Field(() => Float)
  projectedTotalFeedKg: number;

  @Field(() => Float)
  projectedFinalFCR: number;
}

@ObjectType()
export class GrowthRecommendation {
  @Field()
  priority: string;

  @Field()
  type: string;

  @Field()
  description: string;

  @Field()
  reason: string;

  @Field({ nullable: true })
  actionRequired?: string;
}

@ObjectType()
export class GrowthMeasurementSummary {
  @Field(() => ID)
  id: string;

  @Field()
  measurementDate: Date;

  @Field(() => Float)
  averageWeight: number;

  @Field(() => Float)
  weightCV: number;

  @Field(() => Int)
  sampleSize: number;

  @Field(() => Float)
  estimatedBiomass: number;

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
  sgr: number;

  @Field(() => Float)
  initialWeight: number;

  @Field(() => Float)
  finalWeight: number;

  @Field(() => Int)
  daysBetween: number;

  @Field()
  rating: string;

  @Field({ nullable: true })
  speciesTargetSGR?: number;

  @Field(() => Float, { nullable: true })
  varianceFromTarget?: number;
}

@ObjectType()
export class BiomassEstimateResponse {
  @Field(() => Float)
  biomassKg: number;

  @Field(() => Int)
  quantity: number;

  @Field(() => Float)
  avgWeightG: number;

  @Field()
  method: string;

  @Field()
  confidence: string;

  @Field({ nullable: true })
  lastMeasurementDate?: Date;
}

// Types that reference other types - must come after their dependencies
@ObjectType()
export class GrowthMeasurementConnection {
  @Field(() => [GrowthMeasurement])
  items: GrowthMeasurement[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

@ObjectType()
export class GrowthAnalysisResponse {
  @Field(() => ID)
  batchId: string;

  @Field()
  batchCode: string;

  @Field()
  speciesName: string;

  @Field()
  analysisDate: Date;

  @Field(() => Int)
  daysInProduction: number;

  @Field(() => GrowthMetrics)
  currentMetrics: GrowthMetrics;

  @Field(() => GrowthTrend)
  trend: GrowthTrend;

  @Field(() => GrowthProjection)
  projection: GrowthProjection;

  @Field(() => [GrowthRecommendation])
  recommendations: GrowthRecommendation[];

  @Field(() => [GrowthMeasurementSummary])
  measurementHistory: GrowthMeasurementSummary[];
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => GrowthMeasurement)
export class GrowthResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get growth measurement by ID
   */
  @Query(() => GrowthMeasurement, { nullable: true })
  async growthMeasurement(
    @Args('id', { type: () => ID }) id: string,
    @Args('tenantId', { type: () => ID }) tenantId: string,
  ): Promise<GrowthMeasurement | null> {
    const result = await this.queryBus.execute(
      new GetGrowthMeasurementsQuery(tenantId, {}),
    ) as PaginatedQueryResult<GrowthMeasurement>;
    // Filter by ID client-side since filter doesn't support ids
    return result.data.find((item: GrowthMeasurement) => item.id === id) || null;
  }

  /**
   * List growth measurements with filters
   */
  @Query(() => GrowthMeasurementConnection)
  async growthMeasurements(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('filter', { nullable: true }) filter?: GrowthMeasurementFilterInput,
    @Args('pagination', { nullable: true }) pagination?: GrowthPaginationInput,
  ): Promise<GrowthMeasurementConnection> {
    return this.queryBus.execute(
      new GetGrowthMeasurementsQuery(
        tenantId,
        {
          batchId: filter?.batchId,
          tankId: filter?.tankId,
          measurementType: filter?.measurementType ? [filter.measurementType] : undefined,
          fromDate: filter?.startDate,
          toDate: filter?.endDate,
          isVerified: filter?.verifiedOnly,
        },
        1, // page
        pagination?.limit ?? 20,
      ),
    );
  }

  /**
   * Get growth analysis for a batch
   */
  @Query(() => GrowthAnalysisResponse)
  async growthAnalysis(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
  ): Promise<GrowthAnalysisResponse> {
    return this.queryBus.execute(
      new GetGrowthAnalysisQuery(tenantId, batchId),
    );
  }

  /**
   * Get latest measurement for a batch
   */
  @Query(() => GrowthMeasurement, { nullable: true })
  async latestGrowthMeasurement(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
  ): Promise<GrowthMeasurement | null> {
    return this.queryBus.execute(
      new GetLatestMeasurementQuery(tenantId, batchId),
    );
  }

  /**
   * Get measurements for specific batch
   */
  @Query(() => [GrowthMeasurement])
  async batchGrowthHistory(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<GrowthMeasurement[]> {
    const result = await this.queryBus.execute(
      new GetGrowthMeasurementsQuery(
        tenantId,
        { batchId },
        1,
        limit ?? 50,
        'measurementDate',
        'DESC',
      ),
    ) as PaginatedQueryResult<GrowthMeasurement>;
    return result.data;
  }

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  /**
   * Record a new growth sample
   */
  @Mutation(() => GrowthMeasurement)
  async recordGrowthSample(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('userId', { type: () => ID }) userId: string,
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
  async updateBatchWeightFromSample(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('userId', { type: () => ID }) userId: string,
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
  @Mutation(() => GrowthMeasurement)
  async verifyMeasurement(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('measurementId', { type: () => ID }) measurementId: string,
    @Args('userId', { type: () => ID }) userId: string,
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
