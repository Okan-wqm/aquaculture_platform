/**
 * Update AutoRule DTO
 * @module Task/DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { TaskCategory, TaskPriority } from '../entities/task.entity';
import { AutoRuleTrigger } from '../entities/auto-rule.entity';

/**
 * Otomatik kural güncelleme input
 */
@InputType()
export class UpdateAutoRuleInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @Field(() => AutoRuleTrigger, { nullable: true })
  @IsOptional()
  @IsEnum(AutoRuleTrigger)
  trigger?: AutoRuleTrigger;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  triggerCondition?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  taskTitle?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  taskDescription?: string;

  @Field(() => TaskCategory, { nullable: true })
  @IsOptional()
  @IsEnum(TaskCategory)
  taskCategory?: TaskCategory;

  @Field(() => TaskPriority, { nullable: true })
  @IsOptional()
  @IsEnum(TaskPriority)
  taskPriority?: TaskPriority;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignTo?: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
