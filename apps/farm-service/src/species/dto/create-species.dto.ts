/**
 * Create Species DTO
 * @module Species/DTO
 */
import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsUrl,
  ValidateNested,
  Min,
  Max,
  IsArray,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import {
  SpeciesCategory,
  SpeciesWaterType,
  SpeciesStatus,
  OptimalConditions,
  GrowthParameters,
  GrowthStageDefinition,
  MarketInfo,
  BreedingInfo,
} from '../entities/species.entity';

// ============================================================================
// NESTED INPUT TYPES
// ============================================================================

@InputType()
export class TemperatureRangeInput {
  @Field(() => Float)
  @IsNumber()
  @Min(-10)
  @Max(50)
  min: number;

  @Field(() => Float)
  @IsNumber()
  @Min(-10)
  @Max(50)
  max: number;

  @Field(() => Float)
  @IsNumber()
  @Min(-10)
  @Max(50)
  optimal: number;

  @Field({ defaultValue: 'celsius' })
  @IsString()
  unit: 'celsius' | 'fahrenheit';

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  criticalMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  criticalMax?: number;
}

@InputType()
export class PHRangeInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(14)
  min: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(14)
  max: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  optimal?: number;
}

@InputType()
export class DissolvedOxygenInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  min: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  optimal: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  critical?: number;

  @Field({ defaultValue: 'mg/L' })
  @IsString()
  unit: 'mg/L' | 'ppm';
}

@InputType()
export class SalinityInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(50)
  min: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(50)
  max: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  optimal?: number;

  @Field({ defaultValue: 'ppt' })
  @IsString()
  unit: 'ppt' | 'psu';
}

@InputType()
export class WaterParameterLimitInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  max: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  warning?: number;
}

@InputType()
export class CO2RangeInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  min: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  max: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  warning?: number;
}

@InputType()
export class LightRegimeInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(24)
  lightHours: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(24)
  darkHours: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class OptimalConditionsInput {
  @Field(() => TemperatureRangeInput)
  @ValidateNested()
  @Type(() => TemperatureRangeInput)
  temperature: TemperatureRangeInput;

  @Field(() => PHRangeInput)
  @ValidateNested()
  @Type(() => PHRangeInput)
  ph: PHRangeInput;

  @Field(() => DissolvedOxygenInput)
  @ValidateNested()
  @Type(() => DissolvedOxygenInput)
  dissolvedOxygen: DissolvedOxygenInput;

  @Field(() => SalinityInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => SalinityInput)
  salinity?: SalinityInput;

  @Field(() => WaterParameterLimitInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => WaterParameterLimitInput)
  ammonia?: WaterParameterLimitInput;

  @Field(() => WaterParameterLimitInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => WaterParameterLimitInput)
  nitrite?: WaterParameterLimitInput;

  @Field(() => WaterParameterLimitInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => WaterParameterLimitInput)
  nitrate?: WaterParameterLimitInput;

  @Field(() => CO2RangeInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => CO2RangeInput)
  co2?: CO2RangeInput;

  @Field(() => LightRegimeInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LightRegimeInput)
  lightRegime?: LightRegimeInput;
}

@InputType()
export class GrowthParametersInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  maxDensity: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  optimalDensity?: number;

  @Field({ defaultValue: 'kg/m3' })
  @IsString()
  densityUnit: 'kg/m3' | 'pcs/m3';

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  avgDailyGrowth: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  minDailyGrowth?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  maxDailyGrowth?: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  avgHarvestWeight: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  minHarvestWeight?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  maxHarvestWeight?: number;

  @Field({ defaultValue: 'gram' })
  @IsString()
  harvestWeightUnit: 'gram' | 'kg';

  @Field()
  @IsNumber()
  @Min(1)
  avgTimeToHarvestDays: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsNumber()
  minTimeToHarvestDays?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsNumber()
  maxTimeToHarvestDays?: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0.1)
  @Max(10)
  targetFCR: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  minFCR?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  maxFCR?: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(100)
  expectedSurvivalRate: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  minAcceptableSurvival?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  avgSGR?: number;
}

// ============================================================================
// MAIN CREATE DTO
// ============================================================================

@InputType()
export class CreateSpeciesInput {
  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  scientificName: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  commonName: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  localName?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  // -------------------------------------------------------------------------
  // SINIFLANDIRMA
  // -------------------------------------------------------------------------

  @Field(() => SpeciesCategory, { defaultValue: SpeciesCategory.FISH })
  @IsEnum(SpeciesCategory)
  category: SpeciesCategory;

  @Field(() => SpeciesWaterType, { defaultValue: SpeciesWaterType.SALTWATER })
  @IsEnum(SpeciesWaterType)
  waterType: SpeciesWaterType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  family?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  genus?: string;

  // -------------------------------------------------------------------------
  // OPTİMAL KOŞULLAR
  // -------------------------------------------------------------------------

  @Field(() => OptimalConditionsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => OptimalConditionsInput)
  optimalConditions?: OptimalConditionsInput;

  // -------------------------------------------------------------------------
  // BÜYÜME PARAMETRELERİ
  // -------------------------------------------------------------------------

  @Field(() => GrowthParametersInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => GrowthParametersInput)
  growthParameters?: GrowthParametersInput;

  // -------------------------------------------------------------------------
  // BÜYÜME AŞAMALARI
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsArray()
  growthStages?: GrowthStageDefinition[];

  // -------------------------------------------------------------------------
  // PAZAR VE ÜREME BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  marketInfo?: MarketInfo;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  breedingInfo?: BreedingInfo;

  // -------------------------------------------------------------------------
  // DURUM VE GÖRSEL
  // -------------------------------------------------------------------------

  @Field(() => SpeciesStatus, { defaultValue: SpeciesStatus.ACTIVE })
  @IsOptional()
  @IsEnum(SpeciesStatus)
  status?: SpeciesStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsUrl()
  imageUrl?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  // -------------------------------------------------------------------------
  // İLİŞKİLER
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;             // Yavru/Yumurta tedarikçisi

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  feedIds?: string[];              // Bu türe uygun yemler

  // -------------------------------------------------------------------------
  // TAGS - Kategorize ve Filtreleme
  // -------------------------------------------------------------------------

  /**
   * Tür etiketleri - Filtreleme ve kategorize etme için
   * Predefined: smolt, cleaner-fish, broodstock, fry, fingerling, grower, market-size, organic, certified
   * Custom tag'ler de eklenebilir
   */
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
