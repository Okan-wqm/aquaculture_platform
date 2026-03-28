import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';
import { StandardPaginatedResponse } from '@aquaculture/backend-common';
import { MovementType } from '../entities/stock-movement.entity';

@ObjectType()
export class ConditionWarning {
  @Field()
  field!: string;

  @Field()
  message!: string;

  @Field(() => Float, { nullable: true })
  itemMin?: number;

  @Field(() => Float, { nullable: true })
  itemMax?: number;

  @Field(() => Float, { nullable: true })
  locationMin?: number;

  @Field(() => Float, { nullable: true })
  locationMax?: number;
}

@ObjectType()
export class StockMovementResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field(() => MovementType)
  movementType!: MovementType;

  @Field()
  itemType!: string;

  @Field(() => ID)
  itemId!: string;

  @Field()
  itemName!: string;

  @Field(() => Float)
  quantity!: number;

  @Field()
  unit!: string;

  @Field(() => ID, { nullable: true })
  fromLocationId?: string;

  @Field(() => ID, { nullable: true })
  toLocationId?: string;

  @Field({ nullable: true })
  reference?: string;

  @Field({ nullable: true })
  reason?: string;

  @Field(() => ID)
  performedBy!: string;

  /** Display name of the user who performed this movement (denormalized from JWT) */
  @Field({ nullable: true })
  performedByName?: string;

  @Field()
  performedAt!: Date;

  @Field()
  createdAt!: Date;

  /** Lot number for regulatory traceability (EU 178/2002) */
  @Field({ nullable: true })
  lotNumber?: string;

  /** Expiry date of the lot (HACCP audit trail) */
  @Field({ nullable: true })
  expiryDate?: Date;

  // Denormalized location names
  @Field({ nullable: true })
  fromLocationName?: string;

  @Field({ nullable: true })
  toLocationName?: string;

  // Condition mismatch warnings
  @Field(() => [ConditionWarning], { nullable: true })
  warnings?: ConditionWarning[];
}

@ObjectType()
export class PaginatedStockMovementsResponse extends StandardPaginatedResponse(StockMovementResponse) {}
