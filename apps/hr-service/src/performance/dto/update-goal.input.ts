import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsUUID,
  IsString,
  IsOptional,
  IsEnum,
  IsDateString,
  IsNumber,
  IsArray,
  ValidateNested,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GoalPriority, GoalStatus } from '../entities/goal.entity';

@InputType()
export class KeyResultUpdateInput {
  @Field()
  @IsString()
  id!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  currentValue!: number;
}

@InputType()
export class UpdateGoalInput {
  @Field()
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @Field(() => GoalPriority, { nullable: true })
  @IsEnum(GoalPriority)
  @IsOptional()
  priority?: GoalPriority;

  @Field({ nullable: true })
  @IsDateString()
  @IsOptional()
  targetDate?: string;

  @Field(() => GoalStatus, { nullable: true })
  @IsEnum(GoalStatus)
  @IsOptional()
  status?: GoalStatus;
}

@InputType()
export class UpdateGoalProgressInput {
  @Field()
  @IsUUID()
  goalId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(100)
  progressPercent!: number;

  @Field(() => [KeyResultUpdateInput], { nullable: true })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeyResultUpdateInput)
  @IsOptional()
  keyResultUpdates?: KeyResultUpdateInput[];

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;
}
