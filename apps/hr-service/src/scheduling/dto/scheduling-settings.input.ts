import { InputType, Field, ID, Int } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsInt, IsEnum, Min, Max, IsBoolean } from 'class-validator';
import { WeekDay } from '../../attendance/entities/shift.entity';

@InputType()
export class UpdateSchedulingSettingsInput {
  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(60) // 1 hour minimum
  @Max(3600) // 60 hours maximum
  @IsOptional()
  standardWeeklyMinutes?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @Max(1440) // 24 hours max per week
  @IsOptional()
  maxOvertimeMinutesPerWeek?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @Max(5760) // 96 hours max per month
  @IsOptional()
  maxOvertimeMinutesPerMonth?: number;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  defaultShiftId?: string;

  @Field(() => WeekDay, { nullable: true })
  @IsEnum(WeekDay)
  @IsOptional()
  workWeekStartDay?: WeekDay;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  autoNotifyEmployees?: boolean;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @Max(7)
  @IsOptional()
  notifyDaysBefore?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(5)
  @Max(7)
  @IsOptional()
  maxConsecutiveWorkDays?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(480) // 8 hours minimum
  @Max(720) // 12 hours maximum
  @IsOptional()
  minRestMinutesBetweenShifts?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  allowOvertimeWithoutApproval?: boolean;
}
