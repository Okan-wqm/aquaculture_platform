import { ObjectType, Field, Float, Int, ID } from '@nestjs/graphql';

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

@ObjectType()
export class LowStockAlert {
  @Field(() => ID)
  itemId!: string;

  @Field()
  itemName!: string;

  @Field()
  itemType!: string;

  @Field(() => Float)
  currentQuantity!: number;

  @Field(() => Float)
  minStock!: number;

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
