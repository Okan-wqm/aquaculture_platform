/**
 * Filter input for querying stock movements.
 *
 * Extracted from the resolver into its own DTO file following the
 * single-responsibility principle — filter definitions should live
 * alongside other DTOs, not inline in resolver classes.
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsOptional, IsString, IsUUID } from 'class-validator';

@InputType()
export class StockMovementFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  movementType?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  itemType?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @Field({ nullable: true })
  @IsOptional()
  fromDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  toDate?: Date;
}
