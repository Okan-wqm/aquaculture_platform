import { InputType, Field, ID, Int, Float } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  TrainingType,
  TrainingLevel,
} from '../entities/training-course.entity';

/**
 * Input for UpdateTrainingCourse mutation.
 *
 * `id` identifies the row; all other fields optional (partial patch). `code` is
 * NOT updatable — it is the stable per-tenant business key.
 */
@InputType()
export class UpdateTrainingCourseInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsString()
  @Length(1, 200)
  @IsOptional()
  name?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  description?: string;

  @Field(() => TrainingType, { nullable: true })
  @IsEnum(TrainingType)
  @IsOptional()
  trainingType?: TrainingType;

  @Field(() => TrainingLevel, { nullable: true })
  @IsEnum(TrainingLevel)
  @IsOptional()
  level?: TrainingLevel;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(1)
  @IsOptional()
  durationMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @Min(0)
  @IsOptional()
  cost?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isMandatory?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  requiresAssessment?: boolean;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  passingScore?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(1)
  @IsOptional()
  maxAttempts?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  validityMonths?: number;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  certificationTypeId?: string;

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  prerequisites?: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  targetRoles?: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  targetDepartments?: string[];

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isOffshoreRequired?: boolean;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @Length(1, 500)
  externalUrl?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @Length(1, 200)
  provider?: string;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  displayOrder?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
