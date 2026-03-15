import { InputType, Field, ID, Int, Float } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  IsUUID,
  IsArray,
  MaxLength,
  Min,
  Max,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { WorkAreaRiskLevel } from '../entities/work-area.entity';
import { GeoCoordinatesInput } from './create-work-area.input';

@InputType()
export class UpdateWorkAreaInput {
  @Field(() => ID)
  @IsUUID('4', { message: 'ID must be a valid UUID' })
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150, { message: 'Name must be at most 150 characters' })
  @Transform(({ value }) => value?.trim())
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Description must be at most 2000 characters' })
  @Transform(({ value }) => value?.trim())
  description?: string;

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

  @Field({ nullable: true })
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

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  requiresDivingCertification?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  requiresVesselCertification?: boolean;

  @Field({ nullable: true })
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

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
