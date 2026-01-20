/**
 * Create Equipment Input DTO
 */
import { InputType, Field, Float, ID, Int } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, MinLength, IsEnum, IsObject, IsUUID, IsDate, ValidateNested, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { GraphQLJSON } from 'graphql-type-json';
import { EquipmentStatus } from '../entities/equipment.entity';

@InputType()
export class EquipmentLocationInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  building?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  floor?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  room?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  coordinates?: { x: number; y: number; z?: number };

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@InputType()
export class MaintenanceScheduleInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  customDays?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  maintenanceNotes?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  checklistItems?: string[];
}

@InputType()
export class CreateEquipmentInput {
  @Field(() => ID)
  @IsUUID()
  departmentId: string;

  @Field(() => [ID], { description: 'Systems this equipment serves (many-to-many)' })
  @IsUUID('4', { each: true })
  systemIds: string[];

  @Field(() => ID, { nullable: true, description: 'Parent equipment for nested hierarchy' })
  @IsOptional()
  @IsUUID()
  parentEquipmentId?: string;

  @Field(() => ID)
  @IsUUID()
  equipmentTypeId: string;

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

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serialNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  purchaseDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  installationDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  warrantyEndDate?: Date;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  purchasePrice?: number;

  @Field({ nullable: true, defaultValue: 'TRY' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => EquipmentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  @Field(() => EquipmentLocationInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EquipmentLocationInput)
  location?: EquipmentLocationInput;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Dynamic specifications based on equipment type schema' })
  @IsOptional()
  @IsObject()
  specifications?: Record<string, unknown>;

  @Field(() => MaintenanceScheduleInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceScheduleInput)
  maintenanceSchedule?: MaintenanceScheduleInput;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field(() => Float, { nullable: true, description: 'Operating hours' })
  @IsOptional()
  @IsNumber()
  operatingHours?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field({ nullable: true, description: 'Show this equipment in Sensor Module Process Editor' })
  @IsOptional()
  @IsBoolean()
  isVisibleInSensor?: boolean;
}
