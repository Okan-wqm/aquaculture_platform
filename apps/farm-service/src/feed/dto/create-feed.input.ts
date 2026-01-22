/**
 * Create Feed Input DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, MinLength, IsEnum, IsArray, ValidateNested, IsUUID, IsDate } from 'class-validator';
import { Type } from 'class-transformer';
import { GraphQLJSON } from 'graphql-type-json';
import { FeedType, FloatingType } from '../entities/feed.entity';
import { FeedGrowthStage, FeedSpeciesRecommendation } from '../entities/feed-type-species.entity';

@InputType()
export class NutritionalContentInput {
  @Field(() => Float, { nullable: true, description: 'Crude protein percentage' })
  @IsOptional()
  @IsNumber()
  crudeProtein?: number;

  @Field(() => Float, { nullable: true, description: 'Crude fat percentage' })
  @IsOptional()
  @IsNumber()
  crudeFat?: number;

  @Field(() => Float, { nullable: true, description: 'Crude fiber percentage' })
  @IsOptional()
  @IsNumber()
  crudeFiber?: number;

  @Field(() => Float, { nullable: true, description: 'Crude ash percentage' })
  @IsOptional()
  @IsNumber()
  crudeAsh?: number;

  @Field(() => Float, { nullable: true, description: 'Moisture percentage' })
  @IsOptional()
  @IsNumber()
  moisture?: number;

  @Field(() => Float, { nullable: true, description: 'Energy in kcal/kg or MJ/kg' })
  @IsOptional()
  @IsNumber()
  energy?: number;

  @Field({ nullable: true, defaultValue: 'kcal' })
  @IsOptional()
  @IsString()
  energyUnit?: 'kcal' | 'MJ';

  @Field(() => Float, { nullable: true, description: 'Phosphorus percentage' })
  @IsOptional()
  @IsNumber()
  phosphorus?: number;

  @Field(() => Float, { nullable: true, description: 'Calcium percentage' })
  @IsOptional()
  @IsNumber()
  calcium?: number;

  @Field(() => Float, { nullable: true, description: 'Omega-3 percentage' })
  @IsOptional()
  @IsNumber()
  omega3?: number;

  @Field(() => Float, { nullable: true, description: 'Omega-6 percentage' })
  @IsOptional()
  @IsNumber()
  omega6?: number;

  @Field(() => Float, { nullable: true, description: 'Lysine percentage' })
  @IsOptional()
  @IsNumber()
  lysine?: number;

  @Field(() => Float, { nullable: true, description: 'Methionine percentage' })
  @IsOptional()
  @IsNumber()
  methionine?: number;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Vitamins content map' })
  @IsOptional()
  vitamins?: Record<string, number>;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Minerals content map' })
  @IsOptional()
  minerals?: Record<string, number>;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Additional nutritional info' })
  @IsOptional()
  additionalInfo?: Record<string, unknown>;

  @Field(() => Float, { nullable: true, description: 'NFE (Nitrogen-Free Extract) percentage' })
  @IsOptional()
  @IsNumber()
  nfe?: number;

  @Field(() => Float, { nullable: true, description: 'Gross energy in MJ' })
  @IsOptional()
  @IsNumber()
  grossEnergy?: number;

  @Field(() => Float, { nullable: true, description: 'Digestible energy in MJ' })
  @IsOptional()
  @IsNumber()
  digestibleEnergy?: number;
}

@InputType()
export class FeedSpeciesMappingInput {
  @Field(() => ID)
  @IsUUID()
  speciesId: string;

  @Field(() => FeedGrowthStage, { nullable: true })
  @IsOptional()
  @IsEnum(FeedGrowthStage)
  growthStage?: FeedGrowthStage;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  recommendedWeightMinG?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  recommendedWeightMaxG?: number;

  @Field(() => FeedSpeciesRecommendation, { nullable: true })
  @IsOptional()
  @IsEnum(FeedSpeciesRecommendation)
  recommendation?: FeedSpeciesRecommendation;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  priority?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

@InputType()
export class FeedDocumentInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  type: 'datasheet' | 'certificate' | 'label' | 'analysis' | 'other';

  @Field()
  @IsNotEmpty()
  @IsString()
  url: string;

  @Field({ nullable: true })
  @IsOptional()
  uploadedAt?: Date;
}

@InputType()
export class FeedingCurvePointInput {
  @Field(() => Float, { description: 'Fish weight in grams' })
  @IsNumber()
  fishWeightG: number;

  @Field(() => Float, { description: 'Feeding rate as percentage of body weight' })
  @IsNumber()
  feedingRatePercent: number;

  @Field(() => Float, { description: 'Feed Conversion Ratio' })
  @IsNumber()
  fcr: number;
}

@InputType()
export class EnvironmentalImpactInput {
  @Field(() => Float, { nullable: true, description: 'CO2-eq with Land Use Change (kg CO2/kg feed)' })
  @IsOptional()
  @IsNumber()
  co2EqWithLuc?: number;

  @Field(() => Float, { nullable: true, description: 'CO2-eq without Land Use Change (kg CO2/kg feed)' })
  @IsOptional()
  @IsNumber()
  co2EqWithoutLuc?: number;
}

/**
 * 2D Feeding Matrix Input - Temperature x Weight
 * Allows bilinear interpolation between temperature and weight axes
 */
@InputType()
export class FeedingMatrix2DInput {
  @Field(() => [Float], { description: 'Temperature axis values (°C)' })
  @IsArray()
  @IsNumber({}, { each: true })
  temperatures: number[];

  @Field(() => [Float], { description: 'Weight axis values (grams)' })
  @IsArray()
  @IsNumber({}, { each: true })
  weights: number[];

  @Field(() => [[Float]], { description: '2D array: rates[tempIndex][weightIndex] = feeding rate %' })
  @IsArray()
  rates: number[][];

  @Field(() => [[Float]], { nullable: true, description: 'Optional: FCR values at each point' })
  @IsOptional()
  @IsArray()
  fcrMatrix?: number[][];

  @Field({ nullable: true, defaultValue: 'celsius', description: 'Temperature unit' })
  @IsOptional()
  @IsString()
  temperatureUnit?: 'celsius' | 'fahrenheit';

  @Field({ nullable: true, defaultValue: 'gram', description: 'Weight unit' })
  @IsOptional()
  @IsString()
  weightUnit?: 'gram' | 'kg';

  @Field({ nullable: true, description: 'Notes about this feeding matrix' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

@InputType()
export class CreateFeedInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code: string;

  @Field(() => FeedType)
  @IsEnum(FeedType)
  type: FeedType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  brand?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field(() => ID, { description: 'Site this feed is available in' })
  @IsUUID()
  siteId: string;

  @Field({ nullable: true, description: 'Target species (legacy text field)', deprecationReason: 'Use speciesMappings (feed_type_species) instead.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetSpecies?: string;

  @Field(() => [FeedSpeciesMappingInput], {
    nullable: true,
    description: 'Species suitability mappings (persisted to feed_type_species)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeedSpeciesMappingInput)
  speciesMappings?: FeedSpeciesMappingInput[];

  @Field(() => Float, { nullable: true, description: 'Pellet size in mm' })
  @IsOptional()
  @IsNumber()
  pelletSize?: number;

  @Field(() => FloatingType, { nullable: true })
  @IsOptional()
  @IsEnum(FloatingType)
  floatingType?: FloatingType;

  @Field(() => NutritionalContentInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => NutritionalContentInput)
  nutritionalContent?: NutritionalContentInput;

  @Field(() => Float, { nullable: true, description: 'Initial quantity in stock (kg)' })
  @IsOptional()
  @IsNumber()
  quantity?: number;

  @Field(() => Float, { nullable: true, description: 'Minimum stock level (kg)' })
  @IsOptional()
  @IsNumber()
  minStock?: number;

  @Field({ nullable: true, defaultValue: 'kg' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  storageRequirements?: string;

  @Field(() => Int, { nullable: true, description: 'Shelf life in months' })
  @IsOptional()
  @IsNumber()
  shelfLifeMonths?: number;

  @Field({ nullable: true })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiryDate?: Date;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  pricePerKg?: number;

  @Field({ nullable: true, defaultValue: 'TRY' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => [FeedDocumentInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeedDocumentInput)
  documents?: FeedDocumentInput[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  // Yeni alanlar - Pelet ve ürün bilgileri
  @Field({ nullable: true, description: 'Pellet size label (e.g., "2mm", "3-5mm")' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  pelletSizeLabel?: string;

  @Field({ nullable: true, description: 'Product stage' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  productStage?: string;

  @Field({ nullable: true, description: 'Feed composition/ingredients' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  composition?: string;

  // Yeni alanlar - Fiyatlama
  @Field({ nullable: true, description: 'Unit size (e.g., "25kg bag")' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  unitSize?: string;

  @Field(() => Float, { nullable: true, description: 'Unit price' })
  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  // Yeni alanlar - Çevresel etki ve besleme eğrisi
  @Field(() => EnvironmentalImpactInput, { nullable: true, description: 'Environmental impact data' })
  @IsOptional()
  @ValidateNested()
  @Type(() => EnvironmentalImpactInput)
  environmentalImpact?: EnvironmentalImpactInput;

  @Field(() => [FeedingCurvePointInput], { nullable: true, description: 'Feeding curve data points (1D - weight only)' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeedingCurvePointInput)
  feedingCurve?: FeedingCurvePointInput[];

  @Field(() => FeedingMatrix2DInput, { nullable: true, description: '2D feeding matrix (temperature x weight) with bilinear interpolation' })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedingMatrix2DInput)
  feedingMatrix2D?: FeedingMatrix2DInput;
}
