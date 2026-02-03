import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsUUID,
  IsDateString,
  IsOptional,
  IsString,
  IsEnum,
  MaxLength,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { WeekDay } from '../../attendance/entities/shift.entity';

/**
 * Custom validator to ensure weekStartDate is a Monday
 */
@ValidatorConstraint({ name: 'isMonday', async: false })
export class IsMondayConstraint implements ValidatorConstraintInterface {
  validate(value: string, _args: ValidationArguments): boolean {
    const date = new Date(value);
    return !isNaN(date.getTime()) && date.getDay() === 1;
  }

  defaultMessage(_args: ValidationArguments): string {
    return 'weekStartDate must be a Monday';
  }
}

@InputType()
export class CreateWeeklyPlanInput {
  @Field(() => ID)
  @IsUUID('4', { message: 'employeeId must be a valid UUID' })
  employeeId!: string;

  @Field()
  @IsDateString({}, { message: 'weekStartDate must be a valid ISO date string' })
  @Validate(IsMondayConstraint)
  weekStartDate!: string; // ISO date string, must be a Monday

  @Field(() => ID, { nullable: true })
  @IsUUID('4', { message: 'defaultShiftId must be a valid UUID' })
  @IsOptional()
  defaultShiftId?: string;

  @Field(() => [WeekDay], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsEnum(WeekDay, { each: true })
  @ArrayMaxSize(7, { message: 'defaultOffDays cannot have more than 7 days' })
  defaultOffDays?: WeekDay[]; // e.g., [SATURDAY, SUNDAY]

  @Field({ nullable: true })
  @IsString()
  @MaxLength(1000, { message: 'notes cannot exceed 1000 characters' })
  @IsOptional()
  notes?: string;
}

@InputType()
export class CreateBulkWeeklyPlansInput {
  @Field(() => [ID])
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one employeeId is required' })
  @ArrayMaxSize(100, { message: 'Cannot create more than 100 plans at once' })
  @IsUUID('4', { each: true, message: 'Each employeeId must be a valid UUID' })
  employeeIds!: string[];

  @Field()
  @IsDateString({}, { message: 'weekStartDate must be a valid ISO date string' })
  @Validate(IsMondayConstraint)
  weekStartDate!: string;

  @Field(() => ID, { nullable: true })
  @IsUUID('4', { message: 'defaultShiftId must be a valid UUID' })
  @IsOptional()
  defaultShiftId?: string;

  @Field(() => [WeekDay], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsEnum(WeekDay, { each: true })
  @ArrayMaxSize(7, { message: 'defaultOffDays cannot have more than 7 days' })
  defaultOffDays?: WeekDay[];
}
