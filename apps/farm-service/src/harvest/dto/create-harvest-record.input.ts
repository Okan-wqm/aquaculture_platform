/**
 * CreateHarvestRecordInput DTO
 *
 * GraphQL input type for creating harvest records.
 *
 * @module Harvest/DTO
 */
import { InputType, Field, Float, Int } from '@nestjs/graphql';
import { IsNotEmpty, IsUUID, IsPositive, IsOptional, IsString, IsDateString } from 'class-validator';

@InputType()
export class CreateHarvestRecordInput {
  @Field()
  @IsNotEmpty()
  @IsUUID()
  batchId: string;

  @Field()
  @IsNotEmpty()
  @IsUUID()
  tankId: string;

  @Field(() => Int)
  @IsPositive()
  quantityHarvested: number;

  @Field(() => Float)
  @IsPositive()
  averageWeight: number;

  @Field(() => Float)
  @IsPositive()
  totalBiomass: number;

  @Field()
  @IsNotEmpty()
  @IsString()
  qualityGrade: string;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  harvestDate: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsPositive()
  pricePerKg?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  buyerName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
