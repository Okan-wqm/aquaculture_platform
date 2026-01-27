/**
 * Create Department Input DTO
 */
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, MinLength, IsEnum, ValidateNested, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';
import { GraphQLJSON } from 'graphql-type-json';
import { DepartmentType } from '../entities/department.entity';

@InputType()
export class OperatingTemperatureInput {
  @Field(() => Float)
  @IsNumber()
  min!: number;

  @Field(() => Float)
  @IsNumber()
  max!: number;

  @Field()
  @IsString()
  unit!: 'celsius' | 'fahrenheit';
}

@InputType()
export class DepartmentSettingsInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  maxCapacity?: number;

  @Field(() => OperatingTemperatureInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => OperatingTemperatureInput)
  operatingTemperature?: OperatingTemperatureInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  waterType?: 'freshwater' | 'saltwater' | 'brackish';

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  biosecurityLevel?: 'low' | 'medium' | 'high' | 'critical';

  @Field(() => [String], { nullable: true })
  @IsOptional()
  requiredCertifications?: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  customFields?: Record<string, unknown>;
}

@InputType()
export class CreateDepartmentInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code!: string;

  @Field(() => DepartmentType)
  @IsEnum(DepartmentType)
  type!: DepartmentType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  managerId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  managerName?: string;

  @Field(() => DepartmentSettingsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => DepartmentSettingsInput)
  settings?: DepartmentSettingsInput;

  @Field(() => Float, { nullable: true, description: 'Area in square meters' })
  @IsOptional()
  @IsNumber()
  area?: number;

  @Field(() => Float, { nullable: true, description: 'Department capacity' })
  @IsOptional()
  @IsNumber()
  capacity?: number;

  @Field({ nullable: true, description: 'Additional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
