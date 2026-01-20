import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsArray,
  ValidateNested,
  IsEnum,
  IsNumber,
  Min,
  MinLength,
  MaxLength,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AlertOperator, AlertSeverity } from '../../database/entities/alert-rule.entity';

/**
 * Alert Condition Input
 */
@InputType()
export class AlertConditionInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  parameter: string;

  @Field(() => AlertOperator)
  @IsEnum(AlertOperator)
  operator: AlertOperator;

  @Field()
  @IsNumber()
  threshold: number;

  @Field(() => AlertSeverity)
  @IsEnum(AlertSeverity)
  severity: AlertSeverity;
}

/**
 * Create Alert Rule Input
 */
@InputType()
export class CreateAlertRuleInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  farmId?: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  sensorId?: string;

  @Field(() => [AlertConditionInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AlertConditionInput)
  conditions: AlertConditionInput[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  notificationChannels?: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  recipients?: string[];

  @Field(() => Int, { nullable: true, defaultValue: 5 })
  @IsNumber()
  @IsOptional()
  @Min(0)
  cooldownMinutes?: number;
}

/**
 * Update Alert Rule Input
 */
@InputType()
export class UpdateAlertRuleInput {
  @Field(() => ID)
  @IsUUID()
  ruleId: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @Field(() => [AlertConditionInput], { nullable: true })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AlertConditionInput)
  conditions?: AlertConditionInput[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  notificationChannels?: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  recipients?: string[];

  @Field(() => Int, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  cooldownMinutes?: number;

  @Field({ nullable: true })
  @IsOptional()
  isActive?: boolean;
}

/**
 * Acknowledge Alert Input
 */
@InputType()
export class AcknowledgeAlertInput {
  @Field(() => ID)
  @IsUUID()
  alertId: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}
