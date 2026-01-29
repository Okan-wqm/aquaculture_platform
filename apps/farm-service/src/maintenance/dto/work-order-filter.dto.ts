/**
 * WorkOrder Filter DTO
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
  WorkOrderType,
  WorkOrderStatus,
  WorkOrderPriority,
  AssetType,
} from '../entities/work-order.entity';

/**
 * İş emri filtreleme input
 */
@InputType()
export class WorkOrderFilterInput {
  @Field(() => [WorkOrderStatus], { nullable: true })
  @IsOptional()
  @IsEnum(WorkOrderStatus, { each: true })
  status?: WorkOrderStatus[];

  @Field(() => [WorkOrderType], { nullable: true })
  @IsOptional()
  @IsEnum(WorkOrderType, { each: true })
  type?: WorkOrderType[];

  @Field(() => [WorkOrderPriority], { nullable: true })
  @IsOptional()
  @IsEnum(WorkOrderPriority, { each: true })
  priority?: WorkOrderPriority[];

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
  assignedTo?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignedTeamId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  maintenanceScheduleId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dueDateFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dueDateTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isOverdue?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}

/**
 * Sıralama enum
 */
export enum WorkOrderSortField {
  CREATED_AT = 'createdAt',
  DUE_DATE = 'dueDate',
  PRIORITY = 'priority',
  STATUS = 'status',
  TITLE = 'title',
  WORK_ORDER_CODE = 'workOrderCode',
}
