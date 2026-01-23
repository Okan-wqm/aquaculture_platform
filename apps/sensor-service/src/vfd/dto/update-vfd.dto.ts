import { InputType, Field, ID, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsObject,
  IsArray,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { VfdProtocol, VfdDeviceStatus } from '../entities/vfd.enums';

import { ProtocolConfigurationDto } from './protocol-config.dto';

/**
 * Input DTO for updating a VFD device
 */
@InputType('UpdateVfdInput')
export class UpdateVfdDto {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serialNumber?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(VfdProtocol)
  protocol?: VfdProtocol;

  @Field(() => ProtocolConfigurationDto, { nullable: true })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ProtocolConfigurationDto)
  protocolConfiguration?: ProtocolConfigurationDto;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  farmId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(VfdDeviceStatus)
  status?: VfdDeviceStatus;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60000)
  pollIntervalMs?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isPollingEnabled?: boolean;
}

/**
 * Input DTO for updating VFD connection status
 */
@InputType('UpdateVfdConnectionStatusInput')
export class UpdateVfdConnectionStatusDto {
  @Field()
  @IsBoolean()
  isConnected: boolean;

  @Field({ nullable: true })
  @IsOptional()
  lastError?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  latencyMs?: number;
}

/**
 * Input DTO for bulk status update
 */
@InputType('BulkUpdateVfdStatusInput')
export class BulkUpdateVfdStatusDto {
  @Field(() => [ID])
  @IsArray()
  @IsUUID(undefined, { each: true })
  deviceIds: string[];

  @Field(() => String)
  @IsEnum(VfdDeviceStatus)
  status: VfdDeviceStatus;
}
