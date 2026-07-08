/**
 * Update MaintenanceSchedule DTO
 * @module Maintenance/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  IsBoolean,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MaintenanceScheduleStatus,
  MaintenanceCategory,
} from '../entities/maintenance-schedule.entity';
import { AssetType } from '../entities/work-order.entity';
import {
  RecurrenceRuleInput,
  AlertSettingsInput,
} from './create-maintenance-schedule.dto';
import { ChecklistItemInput, RequiredMaterialInput } from './create-work-order.dto';

/**
 * Bakım planı güncelleme input
 */
@InputType()
export class UpdateMaintenanceScheduleInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => MaintenanceCategory, { nullable: true })
  @IsOptional()
  @IsEnum(MaintenanceCategory)
  category?: MaintenanceCategory;

  @Field(() => MaintenanceScheduleStatus, { nullable: true })
  @IsOptional()
  @IsEnum(MaintenanceScheduleStatus)
  status?: MaintenanceScheduleStatus;

  @Field(() => AssetType, { nullable: true })
  @IsOptional()
  @IsEnum(AssetType)
  assetType?: AssetType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  assetName?: string;

  @Field(() => RecurrenceRuleInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => RecurrenceRuleInput)
  recurrenceRule?: RecurrenceRuleInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  estimatedDurationMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedCost?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => [ChecklistItemInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemInput)
  checklistTemplate?: ChecklistItemInput[];

  @Field(() => [RequiredMaterialInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RequiredMaterialInput)
  requiredMaterials?: RequiredMaterialInput[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  instructions?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  defaultAssigneeId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  defaultTeamId?: string;

  @Field(() => AlertSettingsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AlertSettingsInput)
  alertSettings?: AlertSettingsInput;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  autoGenerateWorkOrder?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(30)
  generateDaysBefore?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Meter reading güncelleme input
 */
@InputType()
export class UpdateMeterReadingInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  meterReading!: number;
}

/**
 * Bakım tamamlama input
 */
@InputType()
export class CompleteMaintenanceInput {
  @Field(() => ID)
  @IsUUID()
  scheduleId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  workOrderId?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  meterReading?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
