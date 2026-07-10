/**
 * Create AutoRule DTO
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
 * Otomatik kural oluşturma input
 */
@InputType()
export class CreateAutoRuleInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @Field(() => AutoRuleTrigger)
  @IsNotEmpty()
  @IsEnum(AutoRuleTrigger)
  trigger!: AutoRuleTrigger;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  triggerCondition!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  taskTitle!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  taskDescription?: string;

  @Field(() => TaskCategory)
  @IsNotEmpty()
  @IsEnum(TaskCategory)
  taskCategory!: TaskCategory;

  @Field(() => TaskPriority)
  @IsNotEmpty()
  @IsEnum(TaskPriority)
  taskPriority!: TaskPriority;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignTo?: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
