/**
 * Create Chemical Input DTO
 */
import { InputType, Field, Int, Float, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, MinLength, IsEnum, IsArray, ValidateNested, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';
import { ChemicalType } from '../entities/chemical.entity';

@InputType()
export class FirstAidInfoInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  inhalation?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  skinContact?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  eyeContact?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  ingestion?: string;
}

@InputType()
export class ChemicalSafetyInfoInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  hazardClass?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  signalWord?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  hazardStatements?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  precautionaryStatements?: string[];

  @Field(() => FirstAidInfoInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FirstAidInfoInput)
  firstAid?: FirstAidInfoInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  storageConditions?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  disposalMethod?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  msdsUrl?: string;
}

@InputType()
export class UsageProtocolInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  dosage: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  applicationMethod: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  frequency?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  duration?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  withdrawalPeriod?: number;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  targetSpecies?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  targetConditions?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  contraindications?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  precautions?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class ChemicalDocumentInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  type: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  url: string;

  @Field({ nullable: true })
  @IsOptional()
  uploadedAt?: Date;
}

@InputType()
export class CreateChemicalInput {
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

  @Field(() => ChemicalType)
  @IsEnum(ChemicalType)
  type: ChemicalType;

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

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field(() => ID, { description: 'Site this chemical is available in' })
  @IsUUID()
  siteId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  activeIngredient?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  concentration?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  formulation?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  unit: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  quantity?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  minStock?: number;

  @Field(() => UsageProtocolInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => UsageProtocolInput)
  usageProtocol?: UsageProtocolInput;

  @Field(() => ChemicalSafetyInfoInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChemicalSafetyInfoInput)
  safetyInfo?: ChemicalSafetyInfoInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  storageRequirements?: string;

  @Field(() => Int, { nullable: true, description: 'Shelf life in months' })
  @IsOptional()
  @IsNumber()
  shelfLifeMonths?: number;

  @Field({ nullable: true })
  @IsOptional()
  expiryDate?: Date;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  usageAreas?: string[];

  @Field(() => [ChemicalDocumentInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChemicalDocumentInput)
  documents?: ChemicalDocumentInput[];

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
