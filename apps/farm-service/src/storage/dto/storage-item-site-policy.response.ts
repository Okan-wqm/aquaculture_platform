/**
 * GraphQL view of one per-site stock policy (plan K8 tier 1).
 */
import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

import { StorageItemType } from '../entities/storage-inventory.entity';

@ObjectType()
export class StorageItemSitePolicyResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  siteId!: string;

  @Field(() => StorageItemType)
  itemType!: StorageItemType;

  @Field(() => ID)
  itemId!: string;

  @Field(() => Float)
  minStock!: number;

  @Field(() => ID)
  createdBy!: string;

  @Field(() => ID)
  updatedBy!: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}
