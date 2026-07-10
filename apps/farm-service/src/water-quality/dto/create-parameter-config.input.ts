/**
 * CreateParameterConfig Input DTO
 */
import { InputType, Field, Float, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  IsEnum,
  IsBoolean,
  IsArray,
  Matches,
  MinLength,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import {
  ParameterDataType,
  ParameterGroup,
} from '../entities/water-quality-parameter-config.entity';
import GraphQLJSON from 'graphql-type-json';

@InputType()
export class CreateParameterConfigInput {
  @Field({ description: 'Machine-readable code (lowercase, underscores allowed)' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'code must start with a lowercase letter and contain only lowercase letters, digits, and underscores',
  })
  @MaxLength(50)
  code!: string;

  @Field({ description: 'Display name' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @Field({ description: 'Measurement unit, e.g. °C, mg/L' })
  @IsString()
  @MaxLength(30)
  unit!: string;

  @Field(() => ParameterDataType, { description: 'Value data type' })
  @IsEnum(ParameterDataType)
  dataType!: ParameterDataType;

  @Field(() => Int, { nullable: true, defaultValue: 2, description: 'Decimal places' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  precision?: number;

  @Field(() => ParameterGroup, { description: 'Parameter group' })
  @IsEnum(ParameterGroup)
  group!: ParameterGroup;

  // -------------------------------------------------------------------------
  // THRESHOLD LIMITS
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Optimal minimum value' })
  @IsOptional()
  @IsNumber()
  optimalMin?: number;

  @Field(() => Float, { nullable: true, description: 'Optimal maximum value' })
  @IsOptional()
  @IsNumber()
  optimalMax?: number;

  @Field(() => Float, { nullable: true, description: 'Warning minimum value' })
  @IsOptional()
  @IsNumber()
  warningMin?: number;

  @Field(() => Float, { nullable: true, description: 'Warning maximum value' })
  @IsOptional()
  @IsNumber()
  warningMax?: number;

  @Field(() => Float, { nullable: true, description: 'Critical minimum value' })
  @IsOptional()
  @IsNumber()
  criticalMin?: number;

  @Field(() => Float, { nullable: true, description: 'Critical maximum value' })
  @IsOptional()
  @IsNumber()
  criticalMax?: number;

  // -------------------------------------------------------------------------
  // SPECIES LIMITS & ENUM VALUES
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true, description: 'Species-specific threshold overrides' })
  @IsOptional()
  speciesLimits?: Record<string, {
    optimalMin?: number;
    optimalMax?: number;
    warningMin?: number;
    warningMax?: number;
    criticalMin?: number;
    criticalMax?: number;
  }>;

  @Field(() => [String], { nullable: true, description: 'Allowed values when dataType is ENUM' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enumValues?: string[];

  // -------------------------------------------------------------------------
  // DISPLAY CONFIGURATION
  // -------------------------------------------------------------------------

  @Field({ nullable: true, defaultValue: '#3b82f6', description: 'Chart color (hex)' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'chartColor must be a valid 6-digit hex color, e.g. #3b82f6',
  })
  chartColor?: string;

  @Field({ nullable: true, description: 'Icon identifier' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @Field(() => Int, { nullable: true, defaultValue: 0, description: 'Display ordering' })
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @Field({ nullable: true, defaultValue: true, description: 'Visible in UI' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @Field({ nullable: true, defaultValue: false, description: 'Required during measurement entry' })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @Field({ nullable: true, defaultValue: true, description: 'Active and available' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, defaultValue: 'left', description: 'Chart Y-axis group' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  chartAxisGroup?: string;

  @Field({ nullable: true, defaultValue: false, description: 'Show in quick-access panel' })
  @IsOptional()
  @IsBoolean()
  isQuickAccess?: boolean;

  @Field({ nullable: true, description: 'Source template identifier' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  templateSource?: string;
}
