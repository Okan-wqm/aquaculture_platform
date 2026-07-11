/**
 * Update WorkOrder DTO
 * @module Maintenance/DTO
 */
import { InputType, Field, Float, Int, ID, PartialType } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  IsBoolean,
  IsArray,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  WorkOrderType,
  WorkOrderStatus,
  WorkOrderPriority,
} from '../entities/work-order.entity';
import {
  CreateWorkOrderInput,
  ChecklistItemInput,
  RequiredMaterialInput,
  RelatedAssetInput,
} from './create-work-order.dto';

/**
 * Kullanılan malzeme kaydı
 */
@InputType()
export class UsedMaterialInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  materialId?: string;

  @Field()
  @IsString()
  @MaxLength(200)
  name!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  quantity!: number;

  @Field()
  @IsString()
  @MaxLength(20)
  unit!: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  batchNumber?: string;
}

/**
 * İşçilik kaydı input
 */
@InputType()
export class LaborRecordInput {
  @Field(() => ID)
  @IsUUID()
  userId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  userName?: string;

  @Field()
  @IsDateString()
  startTime!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endTime?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  durationMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  hourlyRate?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Checklist öğesi güncelleme (id ile)
 */
@InputType()
export class UpdateChecklistItemInput {
  @Field()
  @IsString()
  id!: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * İş emri güncelleme input
 */
@InputType()
export class UpdateWorkOrderInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => WorkOrderType, { nullable: true })
  @IsOptional()
  @IsEnum(WorkOrderType)
  type?: WorkOrderType;

  @Field(() => WorkOrderStatus, { nullable: true })
  @IsOptional()
  @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;

  @Field(() => WorkOrderPriority, { nullable: true })
  @IsOptional()
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @Field(() => RelatedAssetInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => RelatedAssetInput)
  relatedAsset?: RelatedAssetInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  plannedStartDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  estimatedDurationMinutes?: number;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignedTeamId?: string;

  @Field(() => [ChecklistItemInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemInput)
  checklist?: ChecklistItemInput[];

  @Field(() => [UpdateChecklistItemInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => UpdateChecklistItemInput)
  checklistUpdates?: UpdateChecklistItemInput[];

  @Field(() => [UsedMaterialInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => UsedMaterialInput)
  usedMaterials?: UsedMaterialInput[];

  @Field(() => [LaborRecordInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => LaborRecordInput)
  laborRecords?: LaborRecordInput[];

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

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}

/**
 * İş emri başlatma input
 */
@InputType()
export class StartWorkOrderInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  startTime?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * İş emri tamamlama input
 */
@InputType()
export class CompleteWorkOrderInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  completionNotes?: string;

  @Field(() => [UsedMaterialInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => UsedMaterialInput)
  usedMaterials?: UsedMaterialInput[];

  @Field(() => [LaborRecordInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => LaborRecordInput)
  laborRecords?: LaborRecordInput[];
}

/**
 * İş emri doğrulama input
 */
@InputType()
export class VerifyWorkOrderInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  verificationNotes?: string;

  @Field(() => Boolean, { defaultValue: true })
  @IsBoolean()
  approved!: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

/**
 * İş emri onay input
 */
@InputType()
export class ApproveWorkOrderInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  approvalNotes?: string;
}
