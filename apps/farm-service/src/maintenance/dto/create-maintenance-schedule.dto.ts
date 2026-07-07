/**
 * Create MaintenanceSchedule DTO
 * @module Maintenance/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  IsBoolean,
  IsArray,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MaintenanceCategory,
  RecurrenceType,
} from '../entities/maintenance-schedule.entity';
import { AssetType } from '../entities/work-order.entity';
import { ChecklistItemInput, RequiredMaterialInput } from './create-work-order.dto';

/**
 * Tekrar kuralı input
 */
@InputType()
export class RecurrenceRuleInput {
  @Field(() => RecurrenceType)
  @IsNotEmpty()
  @IsEnum(RecurrenceType)
  type!: RecurrenceType;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  interval?: number;

  @Field(() => [Int], { nullable: true, description: '0-6 (Pazar-Cumartesi)' })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  daysOfWeek?: number[];

  @Field(() => Int, { nullable: true, description: '1-31' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  dayOfMonth?: number;

  @Field(() => [Int], { nullable: true, description: '1-12' })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  monthsOfYear?: number[];

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxOccurrences?: number;

  @Field({ nullable: true, description: 'hours | cycles | km' })
  @IsOptional()
  @IsString()
  meterType?: 'hours' | 'cycles' | 'km';

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  meterInterval?: number;
}

/**
 * Uyarı ayarları input
 */
@InputType()
export class AlertSettingsInput {
  @Field(() => Int, { defaultValue: 7 })
  @IsNumber()
  @Min(1)
  @Max(90)
  daysBeforeDue!: number;

  @Field(() => Boolean, { defaultValue: true })
  @IsBoolean()
  notifyAssignee!: boolean;

  @Field(() => Boolean, { defaultValue: true })
  @IsBoolean()
  notifyManager!: boolean;

  @Field(() => Boolean, { defaultValue: true })
  @IsBoolean()
  emailNotification!: boolean;

  @Field(() => Boolean, { defaultValue: false })
  @IsBoolean()
  smsNotification!: boolean;
}

/**
 * Bakım planı oluşturma input
 */
@InputType()
export class CreateMaintenanceScheduleInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => MaintenanceCategory, { defaultValue: MaintenanceCategory.GENERAL })
  @IsEnum(MaintenanceCategory)
  category!: MaintenanceCategory;

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

  @Field(() => RecurrenceRuleInput)
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => RecurrenceRuleInput)
  recurrenceRule!: RecurrenceRuleInput;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  startDate!: string;

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

  @Field({ nullable: true, defaultValue: 'TRY' })
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

  @Field(() => Boolean, { defaultValue: true })
  @IsBoolean()
  autoGenerateWorkOrder!: boolean;

  @Field(() => Int, { defaultValue: 7, description: 'Due date\'den kaç gün önce iş emri oluştur' })
  @IsNumber()
  @Min(0)
  @Max(30)
  generateDaysBefore!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
