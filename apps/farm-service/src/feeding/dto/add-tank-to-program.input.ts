/**
 * Add Tank to FeedingProgram DTO
 * @module Feeding/DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsArray,
  IsBoolean,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProgramEquipmentType } from '../entities/feeding-program-tank.entity';

// ============================================================================
// SINGLE TANK INPUTS
// ============================================================================

/**
 * Programa tek tank ekleme input
 */
@InputType()
export class AddTankToProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedingProgramId!: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  equipmentId!: string;

  @Field(() => ProgramEquipmentType, { defaultValue: ProgramEquipmentType.TANK })
  @IsOptional()
  @IsEnum(ProgramEquipmentType)
  equipmentType?: ProgramEquipmentType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  temperatureSensorId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Programdan tank cikarma input
 */
@InputType()
export class RemoveTankFromProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedingProgramId!: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  equipmentId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  removalReason?: string;

  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  hardDelete?: boolean;
}

/**
 * Program-tank iliskisi guncelleme input
 */
@InputType()
export class UpdateTankInProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedingProgramTankId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  temperatureSensorId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

// ============================================================================
// BULK TANK INPUTS
// ============================================================================

/**
 * Tek tank ekleme icin input (bulk icinde kullanilir)
 */
@InputType()
export class TankItemInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  equipmentId!: string;

  @Field(() => ProgramEquipmentType, { defaultValue: ProgramEquipmentType.TANK })
  @IsOptional()
  @IsEnum(ProgramEquipmentType)
  equipmentType?: ProgramEquipmentType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  temperatureSensorId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Programa toplu tank ekleme input
 */
@InputType()
export class AddTanksToProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedingProgramId!: string;

  @Field(() => [TankItemInput])
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TankItemInput)
  tanks!: TankItemInput[];
}

/**
 * Programdan toplu tank cikarma input
 */
@InputType()
export class RemoveTanksFromProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedingProgramId!: string;

  @Field(() => [ID])
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  equipmentIds!: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  removalReason?: string;

  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  hardDelete?: boolean;
}

// ============================================================================
// REACTIVATE INPUT
// ============================================================================

/**
 * Programdan cikarilmis tank'i tekrar aktive etme input
 */
@InputType()
export class ReactivateTankInProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedingProgramTankId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  temperatureSensorId?: string;
}
