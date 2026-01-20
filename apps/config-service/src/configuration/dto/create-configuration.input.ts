import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  MaxLength,
  MinLength,
  IsNotEmpty,
  Matches,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ConfigValueType, ConfigEnvironment } from '../entities/configuration.entity';

/**
 * Validation rules input for configuration values
 */
@InputType()
export class ValidationRulesInput {
  @Field({ nullable: true })
  @IsOptional()
  min?: number;

  @Field({ nullable: true })
  @IsOptional()
  max?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  pattern?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedValues?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

/**
 * Create Configuration Input DTO
 */
@InputType()
export class CreateConfigurationInput {
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Service name is required' })
  @MinLength(2, { message: 'Service name must be at least 2 characters' })
  @MaxLength(100, { message: 'Service name must be at most 100 characters' })
  @Matches(/^[a-z][a-z0-9-]*[a-z0-9]$/, {
    message: 'Service name must be lowercase with hyphens (e.g., auth-service)',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  service!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Configuration key is required' })
  @MinLength(2, { message: 'Key must be at least 2 characters' })
  @MaxLength(255, { message: 'Key must be at most 255 characters' })
  @Matches(/^[a-z][a-z0-9_]*[a-z0-9]$/, {
    message: 'Key must be lowercase with underscores (e.g., max_login_attempts)',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  key!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Value is required' })
  @MaxLength(10000, { message: 'Value must be at most 10000 characters' })
  value!: string;

  @Field(() => ConfigValueType, { defaultValue: ConfigValueType.STRING })
  @IsEnum(ConfigValueType, { message: 'Invalid value type' })
  valueType: ConfigValueType = ConfigValueType.STRING;

  @Field(() => ConfigEnvironment, { defaultValue: ConfigEnvironment.ALL })
  @IsEnum(ConfigEnvironment, { message: 'Invalid environment' })
  environment: ConfigEnvironment = ConfigEnvironment.ALL;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Description must be at most 500 characters' })
  @Transform(({ value }) => value?.trim())
  description?: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  isSecret: boolean = false;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Default value must be at most 255 characters' })
  defaultValue?: string;

  @Field(() => ValidationRulesInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ValidationRulesInput)
  validationRules?: ValidationRulesInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Category must be at most 50 characters' })
  @Matches(/^[a-z][a-z0-9-]*$/, {
    message: 'Category must be lowercase with hyphens',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  category?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true, message: 'Each tag must be at most 50 characters' })
  tags?: string[];
}

/**
 * Update Configuration Input DTO
 */
@InputType()
export class UpdateConfigurationInput {
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Configuration ID is required' })
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10000, { message: 'Value must be at most 10000 characters' })
  value?: string;

  @Field(() => ConfigValueType, { nullable: true })
  @IsOptional()
  @IsEnum(ConfigValueType, { message: 'Invalid value type' })
  valueType?: ConfigValueType;

  @Field(() => ConfigEnvironment, { nullable: true })
  @IsOptional()
  @IsEnum(ConfigEnvironment, { message: 'Invalid environment' })
  environment?: ConfigEnvironment;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Description must be at most 500 characters' })
  @Transform(({ value }) => value?.trim())
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Default value must be at most 255 characters' })
  defaultValue?: string;

  @Field(() => ValidationRulesInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ValidationRulesInput)
  validationRules?: ValidationRulesInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Category must be at most 50 characters' })
  category?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Change reason must be at most 255 characters' })
  changeReason?: string;
}

/**
 * Configuration Filter Input DTO
 */
@InputType()
export class ConfigurationFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  service?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  key?: string;

  @Field(() => ConfigEnvironment, { nullable: true })
  @IsOptional()
  @IsEnum(ConfigEnvironment)
  environment?: ConfigEnvironment;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isSecret?: boolean;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

/**
 * Bulk Configuration Input DTO
 */
@InputType()
export class BulkConfigurationInput {
  @Field(() => [CreateConfigurationInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateConfigurationInput)
  configurations!: CreateConfigurationInput[];
}
