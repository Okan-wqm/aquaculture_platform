/**
 * Task Filter DTO
 * @module Task/DTO
 */
import { InputType, Field, Int, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsEnum,
  IsUUID,
  IsDateString,
  IsString,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { TaskStatus, TaskCategory, TaskPriority } from '../entities/task.entity';

/**
 * Görev filtreleme input
 */
@InputType()
export class TaskFilterInput {
  @Field(() => [TaskStatus], { nullable: true })
  @IsOptional()
  @IsEnum(TaskStatus, { each: true })
  status?: TaskStatus[];

  @Field(() => [TaskCategory], { nullable: true })
  @IsOptional()
  @IsEnum(TaskCategory, { each: true })
  category?: TaskCategory[];

  @Field(() => [TaskPriority], { nullable: true })
  @IsOptional()
  @IsEnum(TaskPriority, { each: true })
  priority?: TaskPriority[];

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => Int, { nullable: true, defaultValue: 50 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  offset?: number;
}
