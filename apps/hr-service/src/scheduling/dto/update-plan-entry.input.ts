import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsString, IsBoolean, IsEnum, Matches, MaxLength } from 'class-validator';
import { WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';

@InputType()
export class UpdatePlanEntryInput {
  @Field(() => ID)
  @IsUUID('4', { message: 'entryId must be a valid UUID' })
  entryId!: string;

  @Field(() => ID, { nullable: true })
  @IsUUID('4', { message: 'shiftId must be a valid UUID' })
  @IsOptional()
  shiftId?: string; // null to mark as off day

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isOffDay?: boolean;

  @Field({ nullable: true })
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'Time must be in HH:mm format (e.g., 07:00)' })
  @IsOptional()
  plannedStartTime?: string;

  @Field({ nullable: true })
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'Time must be in HH:mm format (e.g., 15:00)' })
  @IsOptional()
  plannedEndTime?: string;

  @Field(() => WeeklyPlanEntryType, { nullable: true })
  @IsEnum(WeeklyPlanEntryType)
  @IsOptional()
  entryType?: WeeklyPlanEntryType;

  @Field({ nullable: true })
  @IsString()
  @MaxLength(500, { message: 'notes cannot exceed 500 characters' })
  @IsOptional()
  notes?: string;
}
