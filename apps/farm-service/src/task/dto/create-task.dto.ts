/**
 * Create Task DTO
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
import { TaskCategory, TaskPriority } from '../entities/task.entity';

/**
 * Görev oluşturma input
 */
@InputType()
export class CreateTaskInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  title: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => TaskCategory)
  @IsNotEmpty()
  @IsEnum(TaskCategory)
  category: TaskCategory;

  @Field(() => TaskPriority)
  @IsNotEmpty()
  @IsEnum(TaskPriority)
  priority: TaskPriority;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  assignedTo: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  assignedToName: string;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  dueDate: string;

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
