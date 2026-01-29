/**
 * MaintenanceSchedule Filter DTO
 * @module Maintenance/DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsEnum,
  IsUUID,
  IsDateString,
  IsBoolean,
  IsString,
} from 'class-validator';
import {
  MaintenanceScheduleStatus,
  MaintenanceCategory,
  RecurrenceType,
} from '../entities/maintenance-schedule.entity';
import { AssetType } from '../entities/work-order.entity';

/**
 * Bakım planı filtreleme input
 */
@InputType()
export class MaintenanceScheduleFilterInput {
  @Field(() => [MaintenanceScheduleStatus], { nullable: true })
  @IsOptional()
  @IsEnum(MaintenanceScheduleStatus, { each: true })
  status?: MaintenanceScheduleStatus[];

  @Field(() => [MaintenanceCategory], { nullable: true })
  @IsOptional()
  @IsEnum(MaintenanceCategory, { each: true })
  category?: MaintenanceCategory[];

  @Field(() => [RecurrenceType], { nullable: true })
  @IsOptional()
  @IsEnum(RecurrenceType, { each: true })
  recurrenceType?: RecurrenceType[];

  @Field(() => AssetType, { nullable: true })
  @IsOptional()
  @IsEnum(AssetType)
  assetType?: AssetType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  defaultAssigneeId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  defaultTeamId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  nextDueDateFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  nextDueDateTo?: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isOverdue?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  autoGenerateWorkOrder?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}

/**
 * Sıralama enum
 */
export enum MaintenanceScheduleSortField {
  CREATED_AT = 'createdAt',
  NEXT_DUE_DATE = 'nextDueDate',
  NAME = 'name',
  CATEGORY = 'category',
  STATUS = 'status',
  SCHEDULE_CODE = 'scheduleCode',
}
