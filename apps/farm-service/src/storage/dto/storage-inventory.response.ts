import { ObjectType, Field, Float, ID } from '@nestjs/graphql';
import { StorageItemType } from '../entities/storage-inventory.entity';

@ObjectType()
export class StorageInventoryResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field(() => ID)
  storageLocationId!: string;

  @Field(() => StorageItemType)
  itemType!: StorageItemType;

  @Field(() => ID)
  itemId!: string;

  @Field(() => Float)
  quantity!: number;

  @Field()
  unit!: string;

  @Field({ nullable: true })
  lotNumber?: string;

  @Field({ nullable: true })
  expiryDate?: Date;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  // Denormalized fields resolved by query handler
  @Field({ nullable: true })
  itemName?: string;

  @Field({ nullable: true })
  locationName?: string;
}
