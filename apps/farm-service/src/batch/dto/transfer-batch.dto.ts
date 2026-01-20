/**
 * Transfer Batch DTO
 * @module Batch/DTO
 */
import { InputType, Field, Float, Int } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  Min,
  ValidateNested,
  IsArray,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TransferReason } from '../entities/batch-location.entity';

@InputType()
export class TransferDestinationInput {
  @Field()
  @IsNotEmpty()
  locationType: 'tank' | 'pond';

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  quantity: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  biomass: number;
}

@InputType('MultiDestTransferInput')
export class MultiDestTransferInput {
  @Field()
  @IsNotEmpty()
  @IsUUID()
  batchId: string;

  @Field()
  @IsNotEmpty()
  @IsUUID()
  sourceLocationId: string;        // Kaynak BatchLocation ID

  @Field(() => [TransferDestinationInput])
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferDestinationInput)
  destinations: TransferDestinationInput[];

  @Field(() => TransferReason, { defaultValue: TransferReason.OTHER })
  @IsEnum(TransferReason)
  reason: TransferReason;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
