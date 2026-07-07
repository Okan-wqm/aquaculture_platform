/**
 * SubEquipment Input DTOs
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  MaxLength,
  MinLength,
  IsEnum,
  IsObject,
  IsUUID,
  IsDate,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GraphQLJSON } from 'graphql-type-json';
import { EquipmentStatus } from '../entities/equipment.entity';

@InputType()
export class CreateSubEquipmentInput {
  @Field(() => ID)
  @IsUUID()
  parentEquipmentId!: string;

  @Field(() => ID)
  @IsUUID()
  subEquipmentTypeId!: string;

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

  @Field(() => EquipmentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Dynamic specifications based on sub-equipment type schema' })
  @IsOptional()
  @IsObject()
  specifications?: Record<string, unknown>;

  @Field({ nullable: true })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  installationDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

@InputType()
export class UpdateSubEquipmentInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code?: string;

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

  @Field(() => EquipmentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  specifications?: Record<string, unknown>;

  @Field({ nullable: true })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  installationDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@InputType()
export class SubEquipmentFilterInput {
  @Field(() => ID, { nullable: true, description: 'Filter by parent equipment' })
  @IsOptional()
  @IsUUID()
  parentEquipmentId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by sub-equipment type' })
  @IsOptional()
  @IsUUID()
  subEquipmentTypeId?: string;

  @Field(() => EquipmentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, description: 'Search by name, code, or serial number' })
  @IsOptional()
  @IsString()
  search?: string;
}

@InputType()
export class SubEquipmentTypeFilterInput {
  @Field({ nullable: true, description: 'Filter by compatible equipment type code' })
  @IsOptional()
  @IsString()
  compatibleWithEquipmentType?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
