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
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { AlertOperator, AlertSeverity } from '../../database/entities/alert-rule.entity';

/**
 * Alert Condition Input
 */
@InputType()
export class AlertConditionInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  parameter!: string;

  @Field(() => AlertOperator)
  @IsEnum(AlertOperator)
  operator!: AlertOperator;

  @Field()
  @IsNumber()
  threshold!: number;

  @Field(() => AlertSeverity)
  @IsEnum(AlertSeverity)
  severity!: AlertSeverity;
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
  name!: string;

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
  conditions!: AlertConditionInput[];

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
  @Min(1)
  cooldownMinutes?: number;
}

/**
 * Update Alert Rule Input
 */
@InputType()
export class UpdateAlertRuleInput {
  @Field(() => ID)
  @IsUUID()
  ruleId!: string;

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
  @Min(1)
  cooldownMinutes?: number;

  @Field({ nullable: true })
  @IsOptional()
  isActive?: boolean;
}

/**
 * Acknowledge Alert Input
 *
 * MOB-HIGH-006: extends MobileCommandEnvelopeInput because AquaMobil queues
 * acknowledgements offline and replays them with the injected command envelope;
 * `forbidNonWhitelisted` would otherwise reject the replay and silently lose
 * the field worker's ack. The ack is naturally idempotent (re-applying it
 * converges), so the envelope is acceptance-only — no receipt ledger needed.
 */
@InputType()
export class AcknowledgeAlertInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsUUID()
  alertId!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}
