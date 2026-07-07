/**
 * CreateBiomassReportInput DTO
 *
 * Every shape that crosses the GraphQL boundary carries class-validator
 * metadata so malformed payloads never reach the command handler. The
 * structure mirrors `BiomassReportPayload` in the entity exactly.
 *
 * Phase 2.1 of the farm-modulu kalan kör noktalar plan.
 */
import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

@InputType()
export class BiomassSpeciesBreakdownInput {
  @Field()
  @IsString()
  @MaxLength(100)
  speciesId!: string;

  @Field()
  @IsString()
  @MaxLength(200)
  speciesName!: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  fishCount!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  biomassKg!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  avgWeightG!: number;
}

@InputType()
export class BiomassCurrentStockInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  totalKg!: number;

  @Field(() => [BiomassSpeciesBreakdownInput])
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BiomassSpeciesBreakdownInput)
  bySpecies!: BiomassSpeciesBreakdownInput[];
}

@InputType()
export class BiomassStockingRecordInput {
  @Field()
  @IsString()
  date!: string;

  @Field()
  @IsString()
  @MaxLength(100)
  speciesCode!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  supplier?: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  fishCount!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  avgWeightG!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  biomassKg!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

@InputType()
export class BiomassMortalityCauseInput {
  @Field()
  @IsString()
  @MaxLength(100)
  cause!: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  count!: number;
}

@InputType()
export class BiomassMortalityDetailInput {
  @Field()
  @IsString()
  date!: string;

  @Field()
  @IsString()
  @MaxLength(100)
  cause!: string;

  @Field()
  @IsString()
  @MaxLength(100)
  speciesCode!: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  count!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  biomassLossKg?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

@InputType()
export class BiomassMortalityInput {
  @Field(() => Int)
  @IsInt()
  @Min(0)
  totalCount!: number;

  @Field(() => [BiomassMortalityCauseInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BiomassMortalityCauseInput)
  byCause!: BiomassMortalityCauseInput[];

  @Field(() => [BiomassMortalityDetailInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BiomassMortalityDetailInput)
  details!: BiomassMortalityDetailInput[];
}

@InputType()
export class BiomassSlaughterRecordInput {
  @Field()
  @IsString()
  date!: string;

  @Field()
  @IsString()
  @MaxLength(100)
  speciesCode!: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  quantity!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  biomassKg!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  buyer?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

@InputType()
export class BiomassSlaughterInput {
  @Field(() => Int)
  @IsInt()
  @Min(0)
  totalQuantity!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  totalBiomassKg!: number;

  @Field(() => [BiomassSlaughterRecordInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BiomassSlaughterRecordInput)
  records!: BiomassSlaughterRecordInput[];
}

@InputType()
export class BiomassTransferRecordInput {
  @Field()
  @IsString()
  date!: string;

  /** Union limited to IN/OUT at the enum layer to prevent free-string drift. */
  @Field()
  @IsEnum(['IN', 'OUT'] as const)
  direction!: 'IN' | 'OUT';

  @Field()
  @IsString()
  @MaxLength(100)
  speciesCode!: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  fishCount!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  biomassKg!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  counterparty?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

@InputType()
export class BiomassFeedEntryInput {
  @Field()
  @IsString()
  @MaxLength(200)
  feedName!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  brandName?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  quantityKg!: number;
}

@InputType()
export class BiomassFeedConsumptionInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  totalKg!: number;

  @Field(() => [BiomassFeedEntryInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BiomassFeedEntryInput)
  byFeedType!: BiomassFeedEntryInput[];
}

@InputType()
export class CreateBiomassReportInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  /** Calendar month (1 = January, 12 = December) — not zero-indexed. */
  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(12)
  reportMonth!: number;

  @Field(() => Int)
  @IsInt()
  @Min(2000)
  @Max(2100)
  reportYear!: number;

  @Field(() => BiomassCurrentStockInput)
  @ValidateNested()
  @Type(() => BiomassCurrentStockInput)
  currentBiomass!: BiomassCurrentStockInput;

  @Field(() => [BiomassStockingRecordInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BiomassStockingRecordInput)
  stockings!: BiomassStockingRecordInput[];

  @Field(() => BiomassMortalityInput)
  @ValidateNested()
  @Type(() => BiomassMortalityInput)
  mortality!: BiomassMortalityInput;

  @Field(() => BiomassSlaughterInput)
  @ValidateNested()
  @Type(() => BiomassSlaughterInput)
  slaughter!: BiomassSlaughterInput;

  @Field(() => [BiomassTransferRecordInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BiomassTransferRecordInput)
  transfers!: BiomassTransferRecordInput[];

  @Field(() => BiomassFeedConsumptionInput)
  @ValidateNested()
  @Type(() => BiomassFeedConsumptionInput)
  feedConsumption!: BiomassFeedConsumptionInput;
}
