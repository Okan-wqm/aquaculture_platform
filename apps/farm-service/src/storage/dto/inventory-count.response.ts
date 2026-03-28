import { ObjectType, Field, Float, ID } from '@nestjs/graphql';
import { StandardPaginatedResponse } from '@aquaculture/backend-common';
import { InventoryCountStatus } from '../entities/inventory-count.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';

@ObjectType()
export class InventoryCountItemResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => StorageItemType)
  itemType!: StorageItemType;

  @Field(() => ID)
  itemId!: string;

  @Field()
  itemName!: string;

  @Field()
  unit!: string;

  @Field({ nullable: true })
  lotNumber?: string;

  @Field(() => Float)
  expectedQuantity!: number;

  @Field(() => Float, { nullable: true })
  actualQuantity?: number;

  @Field(() => Float, { nullable: true })
  variance?: number;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class InventoryCountResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  countNumber!: string;

  @Field(() => ID)
  storageLocationId!: string;

  @Field(() => InventoryCountStatus)
  status!: InventoryCountStatus;

  @Field({ nullable: true })
  startedAt?: Date;

  @Field({ nullable: true })
  completedAt?: Date;

  @Field({ nullable: true })
  approvedAt?: Date;

  @Field(() => ID)
  performedBy!: string;

  @Field({ nullable: true })
  performedByName?: string;

  @Field(() => ID, { nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  approvedByName?: string;

  @Field({ nullable: true })
  notes?: string;

  @Field(() => Float)
  totalVariance!: number;

  @Field(() => [InventoryCountItemResponse])
  items!: InventoryCountItemResponse[];

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class PaginatedInventoryCountsResponse extends StandardPaginatedResponse(InventoryCountResponse) {}
