import { InputType, Field, Float, ObjectType, Int } from '@nestjs/graphql';
import {
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';

import { VfdCommandType } from '../entities/vfd.enums';

/**
 * Input DTO for sending VFD commands
 */
@InputType('VfdCommandInput')
export class VfdCommandDto {
  @Field(() => String)
  @IsEnum(VfdCommandType)
  command: VfdCommandType;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  value?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  waitForAck?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(100)
  @Max(30000)
  timeoutMs?: number;
}

/**
 * Input DTO for setting VFD frequency
 */
@InputType('SetVfdFrequencyInput')
export class SetVfdFrequencyDto {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(500)
  frequencyHz: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(100)
  rampTimeSeconds?: number;
}

/**
 * Input DTO for setting VFD speed percentage
 */
@InputType('SetVfdSpeedInput')
export class SetVfdSpeedDto {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(110)
  speedPercent: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(100)
  rampTimeSeconds?: number;
}

/**
 * Output DTO for VFD command result
 */
@ObjectType('VfdCommandResult')
export class VfdCommandResultDto {
  @Field()
  success: boolean;

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  acknowledgedAt?: Date;

  @Field(() => Int, { nullable: true })
  latencyMs?: number;

  @Field({ nullable: true })
  commandSent?: string;

  @Field({ nullable: true })
  previousValue?: number;

  @Field({ nullable: true })
  newValue?: number;
}

/**
 * Output DTO for VFD status after command
 */
@ObjectType('VfdCommandStatus')
export class VfdCommandStatusDto {
  @Field()
  deviceId: string;

  @Field()
  command: VfdCommandType;

  @Field()
  status: 'pending' | 'sent' | 'acknowledged' | 'completed' | 'failed';

  @Field({ nullable: true })
  sentAt?: Date;

  @Field({ nullable: true })
  completedAt?: Date;

  @Field({ nullable: true })
  error?: string;
}

/**
 * Input for batch VFD commands
 */
@InputType('BatchVfdCommandInput')
export class BatchVfdCommandDto {
  @Field(() => [String])
  deviceIds: string[];

  @Field(() => String)
  @IsEnum(VfdCommandType)
  command: VfdCommandType;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  value?: number;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  sequential?: boolean;
}

/**
 * Output for batch VFD command results
 */
@ObjectType('BatchVfdCommandResult')
export class BatchVfdCommandResultDto {
  @Field()
  totalDevices: number;

  @Field()
  successCount: number;

  @Field()
  failureCount: number;

  @Field(() => [VfdCommandResultDto])
  results: VfdCommandResultDto[];
}

/**
 * Emergency stop input - no extra params needed
 */
@InputType('EmergencyStopInput')
export class EmergencyStopDto {
  @Field(() => [String], { nullable: true })
  @IsOptional()
  deviceIds?: string[];

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  allDevices?: boolean;
}

/**
 * Control word direct write (advanced)
 */
@InputType('WriteControlWordInput')
export class WriteControlWordDto {
  @Field(() => Int)
  @IsNumber()
  @Min(0)
  @Max(65535)
  controlWord: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  registerAddress?: number;
}
