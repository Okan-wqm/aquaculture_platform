import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  MaxLength,
  Min,
  Max,
  IsInt,
} from 'class-validator';
import { Transform } from 'class-transformer';

@InputType()
export class UpdateWorkRotationInput {
  @Field(() => ID)
  @IsUUID('4', { message: 'ID must be a valid UUID' })
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString({}, { message: 'Start date must be a valid ISO date string' })
  startDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString({}, { message: 'End date must be a valid ISO date string' })
  endDate?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt({ message: 'Days on must be an integer' })
  @Min(1, { message: 'Days on must be at least 1' })
  @Max(365, { message: 'Days on must be at most 365' })
  daysOn?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt({ message: 'Days off must be an integer' })
  @Min(0, { message: 'Days off must be non-negative' })
  @Max(365, { message: 'Days off must be at most 365' })
  daysOff?: number;

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
