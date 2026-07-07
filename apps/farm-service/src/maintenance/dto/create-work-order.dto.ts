/**
 * Create WorkOrder DTO
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
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  WorkOrderType,
  WorkOrderPriority,
  AssetType,
} from '../entities/work-order.entity';

/**
 * Checklist öğesi input
 */
@InputType()
export class ChecklistItemInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  description!: string;

  @Field(() => Boolean, { defaultValue: false })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedMinutes?: number;
}

/**
 * Gerekli malzeme input
 */
@InputType()
export class RequiredMaterialInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  sparePartId?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.01)
  quantity!: number;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  unit!: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedCost?: number;
}

/**
 * İlişkili varlık input
 */
@InputType()
export class RelatedAssetInput {
  @Field(() => AssetType)
  @IsNotEmpty()
  @IsEnum(AssetType)
  assetType!: AssetType;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  assetId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  assetCode?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  assetName?: string;
}

/**
 * İş emri oluşturma input
 */
@InputType()
export class CreateWorkOrderInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  title!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => WorkOrderType, { defaultValue: WorkOrderType.CORRECTIVE })
  @IsEnum(WorkOrderType)
  type!: WorkOrderType;

  @Field(() => WorkOrderPriority, { defaultValue: WorkOrderPriority.MEDIUM })
  @IsEnum(WorkOrderPriority)
  priority!: WorkOrderPriority;

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

  @Field(() => [RequiredMaterialInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RequiredMaterialInput)
  requiredMaterials?: RequiredMaterialInput[];

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

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  maintenanceScheduleId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  instructions?: string;

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
