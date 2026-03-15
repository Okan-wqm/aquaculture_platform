import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsUUID,
  IsString,
  IsOptional,
  IsEnum,
  IsDateString,
  IsArray,
  IsNumber,
  ValidateNested,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GoalPriority } from '../entities/goal.entity';

@InputType()
export class KeyResultInput {
  @Field()
  @IsString()
  @MaxLength(500)
  description!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  targetValue!: number;

  @Field(() => Float, { defaultValue: 0 })
  @IsNumber()
  @Min(0)
  currentValue!: number;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  unit?: string;
}

@InputType()
export class MilestoneInput {
  @Field()
  @IsString()
  @MaxLength(200)
  title!: string;

  @Field()
  @IsDateString()
  targetDate!: string;
}

@InputType()
export class CreateGoalInput {
  @Field()
  @IsUUID()
  employeeId!: string;

  @Field()
  @IsString()
  @MaxLength(200)
  title!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  category?: string;

  @Field(() => GoalPriority)
  @IsEnum(GoalPriority)
  priority!: GoalPriority;

  @Field()
  @IsDateString()
  startDate!: string;

  @Field()
  @IsDateString()
  targetDate!: string;

  @Field(() => [KeyResultInput], { nullable: true })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeyResultInput)
  @IsOptional()
  keyResults?: KeyResultInput[];

  @Field({ nullable: true })
  @IsUUID()
  @IsOptional()
  alignedReviewId?: string;

  @Field({ nullable: true })
  @IsUUID()
  @IsOptional()
  parentGoalId?: string;
}
