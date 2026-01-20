import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsNumber,
  Min,
  IsUUID,
  IsDate,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Harvest Batch Input DTO
 */
@InputType()
export class HarvestBatchInput {
  @Field(() => ID)
  @IsUUID()
  batchId: string;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  harvestedQuantity: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  harvestedWeight: number; // in kg

  @Field({ nullable: true })
  @IsDate()
  @IsOptional()
  @Type(() => Date)
  harvestedAt?: Date;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;
}
