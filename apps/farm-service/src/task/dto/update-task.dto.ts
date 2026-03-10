/**
 * Update Task DTO
 * @module Task/DTO
 */
import { InputType, Field, Int, ID } from '@nestjs/graphql';
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
import GraphQLJSON from 'graphql-type-json';
import { TaskCategory, TaskPriority, TaskStatus } from '../entities/task.entity';
import { TaskChecklistItemInput } from './create-task.dto';

/**
 * Görev güncelleme input
 */
@InputType()
export class UpdateTaskInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @Field(() => TaskCategory, { nullable: true })
  @IsOptional()
  @IsEnum(TaskCategory)
  category?: TaskCategory;

  @Field(() => TaskPriority, { nullable: true })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @Field(() => TaskStatus, { nullable: true })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  assignedToName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  dueTime?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  estimatedMinutes?: number;

  @Field(() => [TaskChecklistItemInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskChecklistItemInput)
  checklistItems?: TaskChecklistItemInput[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  notes?: any;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  recurringTemplateId?: string;
}
