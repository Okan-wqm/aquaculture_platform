import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  IsUUID,
  IsDateString,
  MaxLength,
  Min,
  Max,
  IsNotEmpty,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { RotationType } from '../entities/work-rotation.entity';

@InputType()
export class CreateWorkRotationInput {
  @Field(() => ID)
  @IsUUID('4', { message: 'Employee ID must be a valid UUID' })
  employeeId!: string;

  @Field(() => ID)
  @IsUUID('4', { message: 'Work Area ID must be a valid UUID' })
  workAreaId!: string;

  @Field(() => RotationType)
  @IsEnum(RotationType, { message: 'Invalid rotation type' })
  rotationType!: RotationType;

  @Field()
  @IsDateString({}, { message: 'Start date must be a valid ISO date string' })
  startDate!: string;

  @Field()
  @IsDateString({}, { message: 'End date must be a valid ISO date string' })
  endDate!: string;

  @Field(() => Int)
  @IsInt({ message: 'Days on must be an integer' })
  @Min(1, { message: 'Days on must be at least 1' })
  @Max(365, { message: 'Days on must be at most 365' })
  daysOn!: number;

  @Field(() => Int)
  @IsInt({ message: 'Days off must be an integer' })
  @Min(0, { message: 'Days off must be non-negative' })
  @Max(365, { message: 'Days off must be at most 365' })
  daysOff!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Accommodation info must be at most 500 characters' })
  @Transform(({ value }) => value?.trim())
  accommodationInfo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'Supervisor ID must be a valid UUID' })
  supervisorId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'Relief Employee ID must be a valid UUID' })
  reliefEmployeeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Notes must be at most 2000 characters' })
  @Transform(({ value }) => value?.trim())
  notes?: string;
}
