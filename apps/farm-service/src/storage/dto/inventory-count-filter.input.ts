/**
 * Filter input for querying inventory counts.
 *
 * Extracted from the resolver into its own DTO file following the
 * single-responsibility principle — filter definitions should live
 * alongside other DTOs, not inline in resolver classes.
 */
import { InputType, Field, ID, Int } from '@nestjs/graphql';
import { IsOptional, IsEnum, IsUUID, IsInt } from 'class-validator';
import { InventoryCountStatus } from '../entities/inventory-count.entity';

@InputType()
export class InventoryCountFilterInput {
  @Field(() => InventoryCountStatus, { nullable: true })
  @IsOptional()
  @IsEnum(InventoryCountStatus)
  status?: InventoryCountStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  page?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  limit?: number;
}
