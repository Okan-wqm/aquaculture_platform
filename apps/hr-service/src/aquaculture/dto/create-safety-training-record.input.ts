import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsDateString,
  IsArray,
  IsBoolean,
  MaxLength,
  IsNotEmpty,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { SafetyTrainingType } from '../entities/safety-training-record.entity';

@InputType()
export class CreateSafetyTrainingRecordInput {
  @Field(() => ID)
  @IsUUID('4', { message: 'Employee ID must be a valid UUID' })
  employeeId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'Work Area ID must be a valid UUID' })
  workAreaId?: string;

  @Field(() => SafetyTrainingType)
  @IsEnum(SafetyTrainingType, { message: 'Invalid safety training type' })
  trainingType!: SafetyTrainingType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Instructor must be at most 200 characters' })
  @Transform(({ value }) => value?.trim())
  instructor?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Location must be at most 200 characters' })
  @Transform(({ value }) => value?.trim())
  location?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString({}, { message: 'Completed date must be a valid ISO date string' })
  completedDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString({}, { message: 'Expiry date must be a valid ISO date string' })
  expiryDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Certificate number must be at most 100 characters' })
  @Transform(({ value }) => value?.trim())
  certificateNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Notes must be at most 2000 characters' })
  @Transform(({ value }) => value?.trim())
  notes?: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  isMandatoryForOffshore?: boolean;
}
