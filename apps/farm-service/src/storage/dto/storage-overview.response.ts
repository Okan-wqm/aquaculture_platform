import { ObjectType, Field, Float, Int, ID } from '@nestjs/graphql';

import { LowStockLevel } from './warehouse-summary.response';

@ObjectType()
export class CategoryTotal {
  @Field()
  category!: string;

  @Field(() => Float)
  totalQuantity!: number;

  @Field(() => Float, {
    deprecationReason: 'Use totalValueDecimal (exact decimal string, ADR-0004).',
  })
  totalValue!: number;

  @Field(() => Int)
  itemCount!: number;
}

@ObjectType()
export class LocationFillRate {
  @Field(() => ID)
  locationId!: string;

  @Field()
  locationName!: string;

  @Field()
  locationType!: string;

  @Field(() => Float, { nullable: true })
  capacity?: number;

  @Field()
  capacityUnit!: string;

  @Field(() => Float)
  usedCapacity!: number;

  @Field(() => Float)
  fillPercentage!: number;
}

/**
 * One stock tier at or below its threshold (plan K8), read from the ledger by
 * LowStockEvaluator. `(itemId, level, siteId)` identifies a row.
 */
@ObjectType()
export class LowStockAlert {
  @Field(() => ID)
  itemId!: string;

  @Field()
  itemName!: string;

  @Field()
  itemType!: string;

  @Field(() => LowStockLevel)
  level!: LowStockLevel;

  /** The short site for SITE rows; null for POOL rows. */
  @Field(() => ID, { nullable: true })
  siteId!: string | null;

  @Field(() => String, { nullable: true })
  siteName!: string | null;

  /** Physical on-hand of the tier. */
  @Field(() => Float)
  currentQuantity!: number;

  /** Threshold of the tier: site policy minimum, or the catalog reorder point. */
  @Field(() => Float)
  minStock!: number;

  /** Open purchase-order remainder counted toward the POOL position; 0 for SITE. */
  @Field(() => Float)
  onOrderQuantity!: number;

  @Field()
  unit!: string;
}

@ObjectType()
export class StorageOverviewResponse {
  @Field(() => Float, {
    deprecationReason: 'Use totalStockValueDecimal (exact decimal string, ADR-0004).',
  })
  totalStockValue!: number;

  @Field(() => Int)
  totalItems!: number;

  @Field(() => Int)
  lowStockAlertCount!: number;

  @Field(() => Int)
  recentMovementsCount!: number;

  @Field(() => [CategoryTotal])
  categoryTotals!: CategoryTotal[];

  @Field(() => [LocationFillRate])
  locationFillRates!: LocationFillRate[];

  @Field(() => [LowStockAlert])
  lowStockAlerts!: LowStockAlert[];
}
