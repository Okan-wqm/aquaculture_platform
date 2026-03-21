import { InputType, Field, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsDate,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StandardPaginatedResponse } from '@platform/backend-common';

import { AlarmSeverity, AlarmSource, PlcAlarm } from '../entities/plc-alarm.entity';

/**
 * Filter input for querying PLC alarms
 */
@InputType('PlcAlarmFilterInput')
export class PlcAlarmFilterDto {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  plcConnectionId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(AlarmSeverity)
  severity?: AlarmSeverity;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(AlarmSource)
  source?: AlarmSource;

  @Field({ nullable: true })
  @IsOptional()
  acknowledged?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  fromDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  toDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

/**
 * Input for acknowledging an alarm
 */
@InputType('AcknowledgeAlarmInput')
export class AcknowledgeAlarmDto {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/**
 * Input for bulk acknowledging alarms
 */
@InputType('BulkAcknowledgeAlarmsInput')
export class BulkAcknowledgeAlarmsDto {
  @Field(() => [ID])
  @IsUUID('4', { each: true })
  alarmIds!: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/**
 * Paginated PLC alarms response
 */
@ObjectType('PaginatedPlcAlarms')
export class PaginatedPlcAlarmsDto extends StandardPaginatedResponse(PlcAlarm) {}

/**
 * Alarm statistics
 */
@ObjectType('PlcAlarmStats')
export class PlcAlarmStatsDto {
  @Field(() => Int)
  totalActive!: number;

  @Field(() => Int)
  totalUnacknowledged!: number;

  @Field(() => Int)
  criticalCount!: number;

  @Field(() => Int)
  emergencyCount!: number;

  @Field(() => Int)
  warningCount!: number;

  @Field(() => Int)
  infoCount!: number;

  @Field(() => Int)
  last24HoursCount!: number;

  @Field(() => Int)
  last7DaysCount!: number;
}

/**
 * Alarm count by severity
 */
@ObjectType('AlarmCountBySeverity')
export class AlarmCountBySeverityDto {
  @Field(() => Int)
  info!: number;

  @Field(() => Int)
  warning!: number;

  @Field(() => Int)
  critical!: number;

  @Field(() => Int)
  emergency!: number;
}

/**
 * Alarm count by source
 */
@ObjectType('AlarmCountBySource')
export class AlarmCountBySourceDto {
  @Field(() => String)
  source!: string;

  @Field(() => Int)
  count!: number;
}

/**
 * Input for approving an alarm at a specific level
 */
@InputType('ApproveAlarmInput')
export class ApproveAlarmDto {
  @Field(() => Int)
  level!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
