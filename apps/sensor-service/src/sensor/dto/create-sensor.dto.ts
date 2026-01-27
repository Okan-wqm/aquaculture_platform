import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  MinLength,
  MaxLength,
  IsNotEmpty,
} from 'class-validator';

import { SensorType, SensorStatus } from '../../database/entities/sensor.entity';

/**
 * Create Sensor Input DTO
 */
@InputType()
export class CreateSensorInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  serialNumber!: string;

  @Field(() => SensorType)
  @IsEnum(SensorType)
  type!: SensorType;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  manufacturer?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  model?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  firmwareVersion?: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  farmId?: string;
}

/**
 * Update Sensor Input DTO
 */
@InputType()
export class UpdateSensorInput {
  @Field(() => ID)
  @IsUUID()
  sensorId!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @Field(() => SensorStatus, { nullable: true })
  @IsEnum(SensorStatus)
  @IsOptional()
  status?: SensorStatus;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  firmwareVersion?: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  farmId?: string;
}
