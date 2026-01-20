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
import { CommandBus, QueryBus } from '@platform/cqrs';
import GraphQLJSON from 'graphql-type-json';

// Entities
import { FeedingRecord, FeedingMethod, FishAppetite } from '../entities/feeding-record.entity';
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
import { GetFeedingSummaryQuery } from '../queries/get-feeding-summary.query';

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

@InputType()
export class FeedingEnvironmentInput {
  @Field(() => Float, { nullable: true })
  waterTemp?: number;

  @Field(() => Float, { nullable: true })
  dissolvedOxygen?: number;

  @Field({ nullable: true })
  weather?: string;

  @Field({ nullable: true })
  windLevel?: string;

  @Field({ nullable: true })
  visibility?: string;
}

@InputType()
export class FishBehaviorInput {
  @Field(() => FishAppetite)
  appetite: FishAppetite;

  @Field(() => Int)
  feedingIntensity: number;

  @Field({ nullable: true })
  surfaceActivity?: string;

  @Field({ nullable: true })
  schoolingBehavior?: string;

  @Field({ nullable: true })
  abnormalBehavior?: string;
}

@InputType()
export class CreateFeedingRecordInput {
  @Field(() => ID)
  batchId: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field()
  feedingDate: Date;

  @Field()
  feedingTime: string;

  @Field(() => Int, { defaultValue: 1 })
  feedingSequence: number;

  @Field(() => Int, { defaultValue: 1 })
  totalMealsToday: number;

  @Field(() => ID)
  feedId: string;

  @Field({ nullable: true })
  feedBatchNumber?: string;

  @Field(() => Float)
  plannedAmount: number;

  @Field(() => Float)
  actualAmount: number;

  @Field(() => Float, { nullable: true })
  wasteAmount?: number;

  @Field(() => FeedingEnvironmentInput, { nullable: true })
  environment?: FeedingEnvironmentInput;

  @Field(() => FishBehaviorInput, { nullable: true })
  fishBehavior?: FishBehaviorInput;

  @Field(() => FeedingMethod, { defaultValue: FeedingMethod.MANUAL })
  feedingMethod: FeedingMethod;

  @Field(() => ID, { nullable: true })
  equipmentId?: string;

  @Field(() => Int, { nullable: true })
  feedingDurationMinutes?: number;

  @Field(() => Float, { nullable: true })
  feedCost?: number;

  @Field({ nullable: true })
  currency?: string;

  @Field(() => ID)
  fedBy: string;

  @Field({ nullable: true })
  notes?: string;

  @Field({ nullable: true })
  skipReason?: string;
}

@InputType()
export class UpdateFeedingRecordInput {
  @Field(() => Float, { nullable: true })
  actualAmount?: number;

  @Field(() => Float, { nullable: true })
  wasteAmount?: number;

  @Field(() => FeedingEnvironmentInput, { nullable: true })
  environment?: FeedingEnvironmentInput;

  @Field(() => FishBehaviorInput, { nullable: true })
  fishBehavior?: FishBehaviorInput;

  @Field({ nullable: true })
  notes?: string;

  @Field(() => ID, { nullable: true })
  verifiedBy?: string;
}

@InputType()
export class AddFeedInventoryInput {
  @Field(() => ID)
  feedId: string;

  @Field(() => ID)
  siteId: string;

  @Field(() => ID, { nullable: true })
  departmentId?: string;

  @Field(() => Float)
  quantityKg: number;

  @Field({ nullable: true })
  lotNumber?: string;

  @Field({ nullable: true })
  manufacturingDate?: Date;

  @Field({ nullable: true })
  expiryDate?: Date;

  @Field({ nullable: true })
  receivedDate?: Date;

  @Field(() => Float, { nullable: true })
  unitPricePerKg?: number;

  @Field({ nullable: true })
  currency?: string;

  @Field({ nullable: true })
  storageLocation?: string;

  @Field({ nullable: true })
  notes?: string;

  @Field(() => ID)
  createdBy: string;
}

@InputType()
export class ConsumeFeedInventoryInput {
  @Field(() => ID)
  inventoryId: string;

  @Field(() => Float)
  quantityKg: number;

  @Field(() => ConsumptionReason, { defaultValue: ConsumptionReason.FEEDING })
  reason: ConsumptionReason;

  @Field(() => ID, { nullable: true })
  feedingRecordId?: string;

  @Field({ nullable: true })
  notes?: string;
}

@InputType()
export class AdjustFeedInventoryInput {
  @Field(() => ID)
  inventoryId: string;

  @Field(() => AdjustmentType)
  adjustmentType: AdjustmentType;

  @Field(() => Float)
  quantity: number;

  @Field(() => String)
  reason: string;

  @Field(() => String, { nullable: true })
  notes?: string;
}

@InputType()
export class FeedingRecordFilterInput {
  @Field(() => ID, { nullable: true })
  batchId?: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field(() => ID, { nullable: true })
  feedId?: string;

  @Field({ nullable: true })
  startDate?: Date;

  @Field({ nullable: true })
  endDate?: Date;

  @Field(() => FeedingMethod, { nullable: true })
  feedingMethod?: FeedingMethod;
}

@InputType()
export class FeedInventoryFilterInput {
  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field(() => ID, { nullable: true })
  feedId?: string;

  @Field(() => InventoryStatus, { nullable: true })
  status?: InventoryStatus;

  @Field({ nullable: true })
  includeLowStock?: boolean;

  @Field({ nullable: true })
  includeExpiringSoon?: boolean;
}

@InputType('FeedingPaginationInput')
export class FeedingPaginationInput {
  @Field(() => Int, { defaultValue: 1 })
  page: number;

  @Field(() => Int, { defaultValue: 20 })
  limit: number;
}

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
export class FeedingRecordConnection {
  @Field(() => [FeedingRecord])
  items: FeedingRecord[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

@ObjectType()
export class FeedInventoryConnection {
  @Field(() => [FeedInventory])
  items: FeedInventory[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => FeedingRecord)
export class FeedingResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get feeding record by ID
   */
  @Query(() => FeedingRecord, { nullable: true })
  async feedingRecord(
    @Args('id', { type: () => ID }) id: string,
    @Args('tenantId', { type: () => ID }) tenantId: string,
  ): Promise<FeedingRecord | null> {
    // GetFeedingRecordsQuery'de id filtreleme için batchId kullanabiliriz
    // veya doğrudan repository'den çekebiliriz - şimdilik boş filter ile tüm kayıtları alıp filtreleme yapıyoruz
    const result = await this.queryBus.execute(
      new GetFeedingRecordsQuery(tenantId, undefined, 1, 1000),
    );
    const typedResult = result as { items: FeedingRecord[] };
    return typedResult.items.find(item => item.id === id) || null;
  }

  /**
   * List feeding records with filters
   */
  @Query(() => FeedingRecordConnection)
  async feedingRecords(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('filter', { nullable: true }) filter?: FeedingRecordFilterInput,
    @Args('pagination', { nullable: true }) pagination?: FeedingPaginationInput,
  ): Promise<FeedingRecordConnection> {
    return this.queryBus.execute(
      new GetFeedingRecordsQuery(
        tenantId,
        {
          batchId: filter?.batchId,
          tankId: filter?.tankId,
          feedId: filter?.feedId,
          fromDate: filter?.startDate,
          toDate: filter?.endDate,
          feedingMethod: filter?.feedingMethod ? [filter.feedingMethod] : undefined,
        },
        pagination?.page ?? 1,
        pagination?.limit ?? 20,
      ),
    );
  }

  /**
   * Get daily feeding plan for a site
   */
  @Query(() => DailyFeedingPlanResponse)
  async dailyFeedingPlan(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('date', { nullable: true }) date?: Date,
  ): Promise<DailyFeedingPlanResponse> {
    return this.queryBus.execute(
      new GetDailyFeedingPlanQuery(tenantId, siteId, date || new Date()),
    );
  }

  /**
   * Get feeding summary/statistics
   */
  @Query(() => FeedingSummaryResponse)
  async feedingSummary(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('entityType') entityType: 'batch' | 'tank',
    @Args('entityId', { type: () => ID }) entityId: string,
    @Args('startDate', { nullable: true }) startDate?: Date,
    @Args('endDate', { nullable: true }) endDate?: Date,
  ): Promise<FeedingSummaryResponse> {
    return this.queryBus.execute(
      new GetFeedingSummaryQuery(tenantId, entityType, entityId, startDate, endDate),
    );
  }

  /**
   * Get feed inventory
   */
  @Query(() => FeedInventoryConnection)
  async feedInventory(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('filter', { nullable: true }) filter?: FeedInventoryFilterInput,
    @Args('pagination', { nullable: true }) pagination?: FeedingPaginationInput,
  ): Promise<FeedInventoryConnection> {
    return this.queryBus.execute(
      new GetFeedInventoryQuery(
        tenantId,
        {
          siteId: filter?.siteId,
          feedId: filter?.feedId,
          status: filter?.status ? [filter.status] : undefined,
          lowStockOnly: filter?.includeLowStock,
          expiringWithinDays: filter?.includeExpiringSoon ? 30 : undefined,
        },
        pagination?.page ?? 1,
        pagination?.limit ?? 20,
      ),
    );
  }

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  /**
   * Create a new feeding record
   */
  @Mutation(() => FeedingRecord)
  async createFeedingRecord(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('userId', { type: () => ID }) userId: string,
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
          environment: input.environment as any,
          fishBehavior: input.fishBehavior as any,
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
  async updateFeedingRecord(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('userId', { type: () => ID }) userId: string,
    @Args('input') input: UpdateFeedingRecordInput,
  ): Promise<FeedingRecord> {
    return this.commandBus.execute(
      new UpdateFeedingRecordCommand(
        tenantId,
        id,
        {
          actualAmount: input.actualAmount,
          wasteAmount: input.wasteAmount,
          environment: input.environment as any,
          fishBehavior: input.fishBehavior as any,
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
  async addFeedInventory(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('userId', { type: () => ID }) userId: string,
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
  async consumeFeedInventory(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('userId', { type: () => ID }) userId: string,
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
  async adjustFeedInventory(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('userId', { type: () => ID }) userId: string,
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
  @ResolveField(() => Boolean)
  isBelowPlan(@Parent() record: FeedingRecord): boolean {
    return Number(record.actualAmount) < Number(record.plannedAmount);
  }

  /**
   * Is variance acceptable (within ±10%)
   */
  @ResolveField(() => Boolean)
  isVarianceAcceptable(@Parent() record: FeedingRecord): boolean {
    const planned = Number(record.plannedAmount);
    if (planned <= 0) return true;
    const variancePercent = Math.abs(
      ((Number(record.actualAmount) - planned) / planned) * 100,
    );
    return variancePercent <= 10;
  }
}

// ============================================================================
// FEED INVENTORY RESOLVER
// ============================================================================

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
