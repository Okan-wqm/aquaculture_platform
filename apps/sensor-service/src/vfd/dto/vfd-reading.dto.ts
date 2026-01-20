import {
  IsOptional,
  IsUUID,
  IsInt,
  IsDate,
  Min,
  Max,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { InputType, Field, ObjectType, Float, Int, ID } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

/**
 * VFD Parameters Output DTO
 */
@ObjectType('VfdParameters')
export class VfdParametersDto {
  @Field(() => Float, { nullable: true })
  outputFrequency?: number;

  @Field(() => Float, { nullable: true })
  motorSpeed?: number;

  @Field(() => Float, { nullable: true })
  motorCurrent?: number;

  @Field(() => Float, { nullable: true })
  motorVoltage?: number;

  @Field(() => Float, { nullable: true })
  dcBusVoltage?: number;

  @Field(() => Float, { nullable: true })
  outputPower?: number;

  @Field(() => Float, { nullable: true })
  motorTorque?: number;

  @Field(() => Float, { nullable: true })
  powerFactor?: number;

  @Field(() => Float, { nullable: true })
  energyConsumption?: number;

  @Field(() => Float, { nullable: true })
  runningHours?: number;

  @Field(() => Float, { nullable: true })
  powerOnHours?: number;

  @Field(() => Int, { nullable: true })
  startCount?: number;

  @Field(() => Float, { nullable: true })
  driveTemperature?: number;

  @Field(() => Float, { nullable: true })
  motorThermal?: number;

  @Field(() => Float, { nullable: true })
  controlCardTemperature?: number;

  @Field(() => Float, { nullable: true })
  ambientTemperature?: number;

  @Field(() => Int, { nullable: true })
  statusWord?: number;

  @Field(() => Int, { nullable: true })
  faultCode?: number;

  @Field(() => Int, { nullable: true })
  warningWord?: number;

  @Field(() => Int, { nullable: true })
  alarmWord?: number;

  @Field(() => Float, { nullable: true })
  speedReference?: number;

  @Field(() => Float, { nullable: true })
  frequencyReference?: number;
}

/**
 * VFD Status Bits Output DTO
 */
@ObjectType('VfdStatusBits')
export class VfdStatusBitsDto {
  @Field({ nullable: true })
  ready?: boolean;

  @Field({ nullable: true })
  running?: boolean;

  @Field({ nullable: true })
  fault?: boolean;

  @Field({ nullable: true })
  warning?: boolean;

  @Field({ nullable: true })
  atSetpoint?: boolean;

  @Field({ nullable: true })
  direction?: string;

  @Field({ nullable: true })
  voltageEnabled?: boolean;

  @Field({ nullable: true })
  quickStopActive?: boolean;

  @Field({ nullable: true })
  switchOnDisabled?: boolean;

  @Field({ nullable: true })
  remote?: boolean;

  @Field({ nullable: true })
  targetReached?: boolean;

  @Field({ nullable: true })
  internalLimit?: boolean;
}

/**
 * VFD Reading Output DTO
 */
@ObjectType('VfdReading')
export class VfdReadingDto {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  vfdDeviceId: string;

  @Field(() => ID)
  tenantId: string;

  @Field(() => VfdParametersDto)
  parameters: VfdParametersDto;

  @Field(() => VfdStatusBitsDto, { nullable: true })
  statusBits?: VfdStatusBitsDto;

  @Field(() => GraphQLJSON, { nullable: true })
  rawValues?: Record<string, number>;

  @Field(() => Int, { nullable: true })
  latencyMs?: number;

  @Field()
  isValid: boolean;

  @Field({ nullable: true })
  errorMessage?: string;

  @Field()
  timestamp: Date;

  @Field()
  createdAt: Date;
}

/**
 * Input for querying VFD readings
 */
@InputType('VfdReadingsQueryInput')
export class VfdReadingsQueryDto {
  @Field(() => ID)
  @IsUUID()
  vfdDeviceId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  from?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  to?: Date;

  @Field(() => Int, { nullable: true, defaultValue: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * VFD Reading Statistics Output DTO
 */
@ObjectType('VfdReadingStats')
export class VfdReadingStatsDto {
  @Field(() => ID)
  vfdDeviceId: string;

  @Field()
  period: string;

  @Field()
  timestamp: Date;

  @Field(() => Float, { nullable: true })
  avgOutputFrequency?: number;

  @Field(() => Float, { nullable: true })
  maxOutputFrequency?: number;

  @Field(() => Float, { nullable: true })
  minOutputFrequency?: number;

  @Field(() => Float, { nullable: true })
  avgMotorCurrent?: number;

  @Field(() => Float, { nullable: true })
  maxMotorCurrent?: number;

  @Field(() => Float, { nullable: true })
  avgOutputPower?: number;

  @Field(() => Float, { nullable: true })
  maxOutputPower?: number;

  @Field(() => Float, { nullable: true })
  totalEnergy?: number;

  @Field(() => Int, { nullable: true })
  runningMinutes?: number;

  @Field(() => Int, { nullable: true })
  faultCount?: number;

  @Field(() => Int, { nullable: true })
  warningCount?: number;
}

/**
 * Input for reading statistics query
 */
@InputType('VfdReadingStatsQueryInput')
export class VfdReadingStatsQueryDto {
  @Field(() => ID)
  @IsUUID()
  vfdDeviceId: string;

  @Field()
  @IsEnum(['hour', 'day', 'week', 'month'])
  period: 'hour' | 'day' | 'week' | 'month';

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  from?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  to?: Date;
}

/**
 * Latest readings for multiple devices
 */
@ObjectType('VfdLatestReadings')
export class VfdLatestReadingsDto {
  @Field(() => [VfdReadingDto])
  readings: VfdReadingDto[];

  @Field()
  fetchedAt: Date;
}

/**
 * Paginated VFD readings response
 */
@ObjectType('PaginatedVfdReadings')
export class PaginatedVfdReadingsDto {
  @Field(() => [VfdReadingDto])
  items: VfdReadingDto[];

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  totalPages: number;
}
