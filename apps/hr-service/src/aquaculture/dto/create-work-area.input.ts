import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  IsArray,
  MaxLength,
  MinLength,
  IsNotEmpty,
  Min,
  Max,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { WorkAreaType } from '../../common/enums';
import { WorkAreaRiskLevel } from '../entities/work-area.entity';

@InputType()
export class GeoCoordinatesInput {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;
}

@InputType()
export class CreateWorkAreaInput {
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Code is required' })
  @MinLength(1, { message: 'Code must be at least 1 character' })
  @MaxLength(30, { message: 'Code must be at most 30 characters' })
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'Code must be alphanumeric with hyphens and underscores' })
  @Transform(({ value }) => value?.trim().toUpperCase())
  code!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MinLength(1, { message: 'Name must be at least 1 character' })
  @MaxLength(150, { message: 'Name must be at most 150 characters' })
  @Transform(({ value }) => value?.trim())
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Description must be at most 2000 characters' })
  @Transform(({ value }) => value?.trim())
  description?: string;

  @Field(() => WorkAreaType)
  @IsEnum(WorkAreaType, { message: 'Invalid work area type' })
  workAreaType!: WorkAreaType;

  @Field(() => WorkAreaRiskLevel, { nullable: true })
  @IsOptional()
  @IsEnum(WorkAreaRiskLevel, { message: 'Invalid risk level' })
  riskLevel?: WorkAreaRiskLevel;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  siteId?: string;

  @Field(() => GeoCoordinatesInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => GeoCoordinatesInput)
  coordinates?: GeoCoordinatesInput;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  isOffshore?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt({ message: 'Max capacity must be an integer' })
  @Min(1, { message: 'Max capacity must be at least 1' })
  @Max(10000, { message: 'Max capacity must be at most 10000' })
  maxCapacity?: number;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  requiredCertifications?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  requiredPPE?: string[];

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  requiresDivingCertification?: boolean;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  requiresVesselCertification?: boolean;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  requiresSeaWorthy?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  emergencyContact?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  emergencyProcedure?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'Color code must be a valid hex color (e.g. #FF0000)' })
  colorCode?: string;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
