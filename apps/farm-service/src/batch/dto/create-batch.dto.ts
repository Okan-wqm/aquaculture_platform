/**
 * Create Batch DTO
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
  IsDateString,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BatchInputType, BatchStatus, ArrivalMethod } from '../entities/batch.entity';
import { BatchDocumentType } from '../entities/batch-document.entity';

@InputType()
export class InitialWeightInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0.001)
  avgWeight: number;               // g

  @Field(() => Float)
  @IsNumber()
  @Min(0.001)
  totalBiomass: number;            // kg
}

@InputType()
export class InitialLocationInput {
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

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  allocationDate?: string;
}

/**
 * Input type for batch documents (health certificates, import documents)
 */
@InputType()
export class BatchDocumentInput {
  @Field(() => BatchDocumentType)
  @IsEnum(BatchDocumentType)
  documentType: BatchDocumentType;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  documentName: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  documentNumber?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  storagePath: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  storageUrl: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  originalFilename: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  mimeType: string;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  fileSize: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  issuingAuthority?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class CreateBatchInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field()
  @IsNotEmpty()
  @IsUUID()
  speciesId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  strain?: string;

  @Field(() => BatchInputType, { defaultValue: BatchInputType.FRY })
  @IsEnum(BatchInputType)
  inputType: BatchInputType;

  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  initialQuantity: number;

  @Field(() => InitialWeightInput)
  @ValidateNested()
  @Type(() => InitialWeightInput)
  initialWeight: InitialWeightInput;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  stockedAt: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  expectedHarvestDate?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.5)
  @Max(5)
  targetFCR: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierBatchNumber?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseCost?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  // Transport / Arrival information
  @Field(() => ArrivalMethod, { nullable: true })
  @IsOptional()
  @IsEnum(ArrivalMethod)
  arrivalMethod?: ArrivalMethod;

  // Documents
  @Field(() => [BatchDocumentInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => BatchDocumentInput)
  healthCertificates?: BatchDocumentInput[];

  @Field(() => [BatchDocumentInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => BatchDocumentInput)
  importDocuments?: BatchDocumentInput[];

  // Tank allocations
  @Field(() => [InitialLocationInput])
  @ValidateNested({ each: true })
  @Type(() => InitialLocationInput)
  initialLocations: InitialLocationInput[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
