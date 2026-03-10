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
} from 'class-validator';
import GraphQLJSON from 'graphql-type-json';
import { TaskCategory, TaskPriority, TaskStatus } from '../entities/task.entity';

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
  location?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  estimatedMinutes?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  checklistItems?: any;

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
