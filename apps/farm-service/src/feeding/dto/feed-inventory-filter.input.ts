/**
 * FeedInventory Filter DTO
 * @module Feeding/DTO
 */
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsEnum,
  IsUUID,
  IsDateString,
  IsBoolean,
  IsString,
  IsNumber,
  Min,
} from 'class-validator';
import { InventoryStatus } from '../entities/feed-inventory.entity';

/**
 * Feed inventory filter input
 */
@InputType()
export class FeedInventoryFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  feedId?: string;

  @Field(() => [ID], { nullable: true })
  @IsOptional()
  @IsUUID('4', { each: true })
  feedIds?: string[];

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => [ID], { nullable: true })
  @IsOptional()
  @IsUUID('4', { each: true })
  siteIds?: string[];

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => [InventoryStatus], { nullable: true })
  @IsOptional()
  @IsEnum(InventoryStatus, { each: true })
  status?: InventoryStatus[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  lotNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  expiryDateFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  expiryDateTo?: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isLowStock?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isExpired?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isExpiringSoon?: boolean;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minQuantityKg?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxQuantityKg?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  storageLocation?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}

/**
 * Feed inventory sort field enum
 */
export enum FeedInventorySortField {
  CREATED_AT = 'createdAt',
  QUANTITY_KG = 'quantityKg',
  EXPIRY_DATE = 'expiryDate',
  LOT_NUMBER = 'lotNumber',
  STATUS = 'status',
  FEED_ID = 'feedId',
  SITE_ID = 'siteId',
}
