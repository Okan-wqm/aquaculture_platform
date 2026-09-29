/**
 * Inputs for the per-site stock policy (plan K8 tier 1, FARM-HIGH-336).
 *
 * WHY `minStock` must be positive: a zero minimum is "no policy" and is a
 * delete; the migration's CHECK enforces the same rule in the database, and
 * the input only admits values numeric(15,2) stores as positive.
 */
import { Field, Float, ID, InputType } from '@nestjs/graphql';
import { IsEnum, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { StorageItemType } from '../entities/storage-inventory.entity';

/** numeric(15,2) upper bound — anything larger cannot be stored. */
const MAX_POLICY_MIN_STOCK = 9_999_999_999_999.99;

@InputType()
export class UpsertStorageItemSitePolicyInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => StorageItemType)
  @IsEnum(StorageItemType)
  itemType!: StorageItemType;

  @Field(() => ID)
  @IsUUID()
  itemId!: string;

  // WHY two decimals and >= 0.01: the column is numeric(15,2), so 0.001 would
  // round to 0.00 in the database and hit the CHECK (min_stock > 0) as a raw
  // 23514. The input rejects every value the column cannot hold as positive.
  @Field(() => Float, { description: 'Minimum on-hand the site must hold (>= 0.01, 2 decimals)' })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(MAX_POLICY_MIN_STOCK)
  minStock!: number;
}

@InputType()
export class StorageItemSitePolicyFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => StorageItemType, { nullable: true })
  @IsOptional()
  @IsEnum(StorageItemType)
  itemType?: StorageItemType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  itemId?: string;
}
