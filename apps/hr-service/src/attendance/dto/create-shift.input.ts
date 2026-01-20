import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  IsBoolean,
  MaxLength,
  Min,
  Max,
  IsArray,
} from 'class-validator';
import { ShiftType, WeekDay } from '../entities/shift.entity';

@InputType()
export class BreakPeriodInput {
  @Field()
  @IsString()
  startTime!: string; // HH:mm format

  @Field()
  @IsString()
  endTime!: string; // HH:mm format

  @Field({ defaultValue: false })
  @IsBoolean()
  isPaid!: boolean;
}

@InputType()
export class CreateShiftInput {
  @Field()
  @IsString()
  @MaxLength(20)
  code!: string;

  @Field()
  @IsString()
  @MaxLength(100)
  name!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @Field(() => ShiftType, { defaultValue: ShiftType.REGULAR })
  @IsEnum(ShiftType)
  shiftType!: ShiftType;

  @Field()
  @IsString()
  startTime!: string; // HH:mm format

  @Field()
  @IsString()
  endTime!: string; // HH:mm format

  @Field(() => Int, { nullable: true })
  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(1440)
  totalMinutes?: number;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  breakMinutes!: number;

  @Field(() => [BreakPeriodInput], { nullable: true })
  @IsArray()
  @IsOptional()
  breakPeriods?: BreakPeriodInput[];

  @Field(() => [WeekDay], { nullable: true })
  @IsArray()
  @IsOptional()
  workDays?: WeekDay[];

  @Field({ defaultValue: false })
  @IsBoolean()
  crossesMidnight!: boolean;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  graceMinutes!: number;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  earlyClockInMinutes!: number;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  lateClockOutMinutes!: number;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(7)
  colorCode?: string;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  displayOrder!: number;
}

@InputType()
export class UpdateShiftInput {
  @Field()
  @IsString()
  id!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @Field(() => ShiftType, { nullable: true })
  @IsEnum(ShiftType)
  @IsOptional()
  shiftType?: ShiftType;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  startTime?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  endTime?: string;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(1440)
  totalMinutes?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @IsOptional()
  @Min(0)
  breakMinutes?: number;

  @Field(() => [BreakPeriodInput], { nullable: true })
  @IsArray()
  @IsOptional()
  breakPeriods?: BreakPeriodInput[];

  @Field(() => [WeekDay], { nullable: true })
  @IsArray()
  @IsOptional()
  workDays?: WeekDay[];

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  crossesMidnight?: boolean;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @IsOptional()
  @Min(0)
  graceMinutes?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(7)
  colorCode?: string;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @IsOptional()
  @Min(0)
  displayOrder?: number;
}
