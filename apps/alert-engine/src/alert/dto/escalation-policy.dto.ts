import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsArray,
  IsEnum,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  MinLength,
  MaxLength,
  IsNotEmpty,
  ValidateNested,
  Matches,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  EscalationActionType,
  NotificationChannel,
} from '../../database/entities/escalation-policy.entity';

// ============================================================================
// Escalation Level Input
// ============================================================================

@InputType()
export class EscalationLevelInput {
  @Field(() => Int)
  @IsNumber()
  @Min(1)
  level!: number;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  timeoutMinutes!: number;

  @Field(() => [String])
  @IsArray()
  notifyUserIds!: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  notifyTeamIds?: string[];

  @Field(() => [NotificationChannel])
  @IsArray()
  channels!: NotificationChannel[];

  @Field(() => EscalationActionType)
  @IsEnum(EscalationActionType)
  action!: EscalationActionType;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  actionConfig?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  messageTemplate?: string;
}

// ============================================================================
// On-Call Schedule Input
// ============================================================================

@InputType()
export class OnCallScheduleInput {
  @Field(() => Int)
  @IsNumber()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @Field()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'Time must be in HH:mm format' })
  startTime!: string;

  @Field()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'Time must be in HH:mm format' })
  endTime!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  backupUserId?: string;
}

// ============================================================================
// Suppression Window Input
// ============================================================================

@InputType()
export class SuppressionWindowInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @Field()
  @IsDateString()
  startTime!: string;

  @Field()
  @IsDateString()
  endTime!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;

  @Field()
  @IsBoolean()
  isRecurring!: boolean;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  recurringPattern?: string;
}

// ============================================================================
// Create Escalation Policy Input
// ============================================================================

@InputType()
export class CreateEscalationPolicyInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @Field(() => [AlertSeverity])
  @IsArray()
  severity!: AlertSeverity[];

  @Field(() => [EscalationLevelInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EscalationLevelInput)
  levels!: EscalationLevelInput[];

  @Field(() => [OnCallScheduleInput], { nullable: true })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => OnCallScheduleInput)
  onCallSchedule?: OnCallScheduleInput[];

  @Field(() => [SuppressionWindowInput], { nullable: true })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SuppressionWindowInput)
  suppressionWindows?: SuppressionWindowInput[];

  @Field(() => Int, { nullable: true, defaultValue: 5 })
  @IsNumber()
  @IsOptional()
  @Min(1)
  repeatIntervalMinutes?: number;

  @Field(() => Int, { nullable: true, defaultValue: 3 })
  @IsNumber()
  @IsOptional()
  @Min(0)
  maxRepeats?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsNumber()
  @IsOptional()
  @Min(0)
  priority?: number;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  timezone?: string;

  @Field(() => [ID], { nullable: true })
  @IsArray()
  @IsOptional()
  ruleIds?: string[];

  @Field(() => [ID], { nullable: true })
  @IsArray()
  @IsOptional()
  farmIds?: string[];
}

// ============================================================================
// Update Escalation Policy Input
// ============================================================================

@InputType()
export class UpdateEscalationPolicyInput {
  @Field(() => ID)
  @IsUUID()
  policyId!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @Field(() => [AlertSeverity], { nullable: true })
  @IsArray()
  @IsOptional()
  severity?: AlertSeverity[];

  @Field(() => [EscalationLevelInput], { nullable: true })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => EscalationLevelInput)
  levels?: EscalationLevelInput[];

  @Field(() => [OnCallScheduleInput], { nullable: true })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => OnCallScheduleInput)
  onCallSchedule?: OnCallScheduleInput[];

  @Field(() => Int, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(1)
  repeatIntervalMinutes?: number;

  @Field(() => Int, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  maxRepeats?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @Field(() => Int, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  priority?: number;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  timezone?: string;

  @Field(() => [ID], { nullable: true })
  @IsArray()
  @IsOptional()
  ruleIds?: string[];

  @Field(() => [ID], { nullable: true })
  @IsArray()
  @IsOptional()
  farmIds?: string[];
}

// ============================================================================
// Add Suppression Window Input
// ============================================================================

@InputType()
export class AddSuppressionWindowInput {
  @Field(() => ID)
  @IsUUID()
  policyId!: string;

  @Field(() => SuppressionWindowInput)
  @ValidateNested()
  @Type(() => SuppressionWindowInput)
  window!: SuppressionWindowInput;
}

// ============================================================================
// Update On-Call Schedule Input
// ============================================================================

@InputType()
export class UpdateOnCallScheduleInput {
  @Field(() => ID)
  @IsUUID()
  policyId!: string;

  @Field(() => [OnCallScheduleInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnCallScheduleInput)
  schedule!: OnCallScheduleInput[];
}

// ============================================================================
// Clone Policy Input
// ============================================================================

@InputType()
export class ClonePolicyInput {
  @Field(() => ID)
  @IsUUID()
  policyId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(200)
  newName!: string;
}
