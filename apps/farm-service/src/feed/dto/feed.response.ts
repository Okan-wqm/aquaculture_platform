/**
 * Feed Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { FeedType, FeedStatus, FloatingType } from '../entities/feed.entity';

// Register enums for GraphQL
registerEnumType(FeedType, {
  name: 'FeedType',
  description: 'Type of feed',
});

registerEnumType(FeedStatus, {
  name: 'FeedStatus',
  description: 'Status of the feed',
});

registerEnumType(FloatingType, {
  name: 'FloatingType',
  description: 'Floating type of feed pellets',
});

@ObjectType()
export class FeedTypeResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  icon?: string;

  @Field()
  isActive!: boolean;

  @Field(() => Int)
  sortOrder!: number;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class NutritionalContentResponse {
  @Field(() => Float, { nullable: true })
  crudeProtein?: number;

  @Field(() => Float, { nullable: true })
  crudeFat?: number;

  @Field(() => Float, { nullable: true })
  crudeFiber?: number;

  @Field(() => Float, { nullable: true })
  crudeAsh?: number;

  @Field(() => Float, { nullable: true })
  moisture?: number;

  @Field(() => Float, { nullable: true })
  energy?: number;

  @Field({ nullable: true })
  energyUnit?: string;

  @Field(() => Float, { nullable: true })
  phosphorus?: number;

  @Field(() => Float, { nullable: true })
  calcium?: number;

  @Field(() => Float, { nullable: true })
  omega3?: number;

  @Field(() => Float, { nullable: true })
  omega6?: number;

  @Field(() => Float, { nullable: true })
  lysine?: number;

  @Field(() => Float, { nullable: true })
  methionine?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  vitamins?: Record<string, number>;

  @Field(() => GraphQLJSON, { nullable: true })
  minerals?: Record<string, number>;

  @Field(() => GraphQLJSON, { nullable: true })
  additionalInfo?: Record<string, unknown>;

  @Field(() => Float, { nullable: true, description: 'NFE (Nitrogen-Free Extract) percentage' })
  nfe?: number;

  @Field(() => Float, { nullable: true, description: 'Gross energy in MJ' })
  grossEnergy?: number;

  @Field(() => Float, { nullable: true, description: 'Digestible energy in MJ' })
  digestibleEnergy?: number;
}

@ObjectType()
export class FeedDocumentResponse {
  @Field({ nullable: true })
  id?: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  type?: string;

  @Field({ nullable: true })
  url?: string;

  @Field({ nullable: true })
  uploadedAt?: string;

  @Field({ nullable: true })
  uploadedBy?: string;
}

@ObjectType()
export class FeedingCurvePointResponse {
  @Field(() => Float, { description: 'Fish weight in grams' })
  fishWeightG!: number;

  @Field(() => Float, { description: 'Feeding rate as percentage of body weight' })
  feedingRatePercent!: number;

  @Field(() => Float, { description: 'Feed Conversion Ratio' })
  fcr!: number;
}

@ObjectType()
export class EnvironmentalImpactResponse {
  @Field(() => Float, { nullable: true, description: 'CO2-eq with Land Use Change (kg CO2/kg feed)' })
  co2EqWithLuc?: number;

  @Field(() => Float, { nullable: true, description: 'CO2-eq without Land Use Change (kg CO2/kg feed)' })
  co2EqWithoutLuc?: number;
}

/**
 * 2D Feeding Matrix Response - Temperature x Weight
 */
@ObjectType()
export class FeedingMatrix2DResponse {
  @Field(() => [Float], { description: 'Temperature axis values (°C)' })
  temperatures!: number[];

  @Field(() => [Float], { description: 'Weight axis values (grams)' })
  weights!: number[];

  @Field(() => [[Float]], { description: '2D array: rates[tempIndex][weightIndex] = feeding rate %' })
  rates!: number[][];

  @Field(() => [[Float]], { nullable: true, description: 'Optional: FCR values at each point' })
  fcrMatrix?: number[][];

  @Field({ nullable: true, description: 'Temperature unit' })
  temperatureUnit?: string;

  @Field({ nullable: true, description: 'Weight unit' })
  weightUnit?: string;

  @Field({ nullable: true, description: 'Notes about this feeding matrix' })
  notes?: string;
}

@ObjectType()
export class FeedResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => FeedType)
  type!: FeedType;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  brand?: string;

  @Field({ nullable: true })
  manufacturer?: string;

  @Field(() => ID, { nullable: true })
  supplierId?: string;

  @Field({ nullable: true })
  targetSpecies?: string;

  @Field(() => Float, { nullable: true, description: 'Pellet size in mm' })
  pelletSize?: number;

  @Field(() => FloatingType)
  floatingType!: FloatingType;

  @Field(() => NutritionalContentResponse, { nullable: true })
  nutritionalContent?: NutritionalContentResponse;

  @Field(() => FeedStatus)
  status!: FeedStatus;

  @Field(() => Float)
  quantity!: number;

  @Field(() => Float)
  minStock!: number;

  @Field()
  unit!: string;

  @Field({ nullable: true })
  storageRequirements?: string;

  @Field(() => Int, { nullable: true })
  shelfLifeMonths?: number;

  @Field({ nullable: true })
  expiryDate?: Date;

  @Field(() => Float, { nullable: true })
  pricePerKg?: number;

  @Field()
  currency!: string;

  @Field(() => [FeedDocumentResponse], { nullable: true })
  documents?: FeedDocumentResponse[];

  @Field({ nullable: true })
  notes?: string;

  // Yeni alanlar - Pelet ve ürün bilgileri
  @Field({ nullable: true, description: 'Pellet size label (e.g., "2mm", "3-5mm")' })
  pelletSizeLabel?: string;

  @Field({ nullable: true, description: 'Product stage' })
  productStage?: string;

  @Field({ nullable: true, description: 'Feed composition/ingredients' })
  composition?: string;

  // Yeni alanlar - Fiyatlama
  @Field({ nullable: true, description: 'Unit size (e.g., "25kg bag")' })
  unitSize?: string;

  @Field(() => Float, { nullable: true, description: 'Unit price' })
  unitPrice?: number;

  // Yeni alanlar - Çevresel etki ve besleme eğrisi
  @Field(() => EnvironmentalImpactResponse, { nullable: true, description: 'Environmental impact data' })
  environmentalImpact?: EnvironmentalImpactResponse;

  @Field(() => [FeedingCurvePointResponse], { nullable: true, description: 'Feeding curve data points (1D - weight only)' })
  feedingCurve?: FeedingCurvePointResponse[];

  @Field(() => FeedingMatrix2DResponse, { nullable: true, description: '2D feeding matrix (temperature x weight) with bilinear interpolation' })
  feedingMatrix2D?: FeedingMatrix2DResponse;

  @Field()
  isActive!: boolean;

  @Field(() => ID, { nullable: true })
  createdBy?: string;

  @Field(() => ID, { nullable: true })
  updatedBy?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class PaginatedFeedsResponse {
  @Field(() => [FeedResponse])
  items!: FeedResponse[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  totalPages!: number;
}
