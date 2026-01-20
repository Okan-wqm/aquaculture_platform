import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsNumber,
  MinLength,
  MaxLength,
  Min,
  IsUUID,
  IsDate,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Create Pond Batch Input DTO
 * Note: Renamed from CreateBatchInput to avoid conflict with Batch module's CreateBatchInput
 */
@InputType('CreatePondBatchInput')
export class CreatePondBatchInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  species: string;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  quantity: number;

  @Field(() => ID)
  @IsUUID()
  pondId: string;

  @Field()
  @IsDate()
  @Type(() => Date)
  stockedAt: Date;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  strain?: string;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  averageWeight?: number;

  @Field({ nullable: true })
  @IsDate()
  @IsOptional()
  @Type(() => Date)
  expectedHarvestDate?: Date;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;
}
