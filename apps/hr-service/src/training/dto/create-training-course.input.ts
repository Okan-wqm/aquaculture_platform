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
  Matches,
  Max,
  Min,
} from 'class-validator';

import {
  TrainingType,
  TrainingLevel,
} from '../entities/training-course.entity';

/**
 * Input for CreateTrainingCourse mutation.
 *
 * Mirrors the writable surface of the TrainingCourse entity read back by the FE
 * TrainingCourseFull fragment (web/modules/hr-module/src/graphql/fragments.ts).
 */
@InputType()
export class CreateTrainingCourseInput {
  @Field()
  @IsString()
  // Per-tenant unique business key (@Index(['tenantId','code'], unique)).
  @Matches(/^[A-Z0-9_-]{1,30}$/, {
    message: 'code must be 1-30 uppercase letters, digits, hyphens or underscores',
  })
  code!: string;

  @Field()
  @IsString()
  @Length(1, 200)
  name!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  description?: string;

  @Field(() => TrainingType, { defaultValue: TrainingType.IN_PERSON })
  @IsEnum(TrainingType)
  @IsOptional()
  trainingType?: TrainingType;

  @Field(() => TrainingLevel, { defaultValue: TrainingLevel.BEGINNER })
  @IsEnum(TrainingLevel)
  @IsOptional()
  level?: TrainingLevel;

  @Field(() => Int, { defaultValue: 60 })
  @IsInt()
  @Min(1)
  @IsOptional()
  durationMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @Min(0)
  @IsOptional()
  cost?: number;

  @Field({ defaultValue: false })
  @IsBoolean()
  @IsOptional()
  isMandatory?: boolean;

  @Field({ defaultValue: false })
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

  @Field({ defaultValue: false })
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

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  displayOrder?: number;

  @Field({ defaultValue: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
