import { InputType, Field, Int, ObjectType, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsUUID,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

import { VfdBrand, VfdProtocol, VfdDeviceStatus } from '../entities/vfd.enums';
import { PaginationInput, PaginatedResponse } from '@platform/backend-common';

/**
 * Filter input for querying VFD devices
 */
@InputType('VfdDeviceFilterInput')
export class VfdDeviceFilterDto {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(VfdDeviceStatus)
  status?: VfdDeviceStatus;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(VfdBrand)
  brand?: VfdBrand;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(VfdProtocol)
  protocol?: VfdProtocol;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  farmId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @Field({ nullable: true })
  @IsOptional()
  isConnected?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  isPollingEnabled?: boolean;
}

/**
 * Pagination input for VFD queries
 *
 * Uses standard offset/limit pattern from @platform/backend-common.
 * Extends PaginationInput with VFD-specific sortBy validation.
 */
@InputType('VfdPaginationInput')
export class VfdPaginationDto extends PaginationInput {
  @Field({ nullable: true, defaultValue: 'createdAt', description: 'Field to sort by (name, brand, status, createdAt, updatedAt)' })
  @IsOptional()
  @IsString()
  @IsEnum(['name', 'brand', 'status', 'createdAt', 'updatedAt'])
  override sortBy?: string;
}

/**
 * VFD Connection Status output DTO
 */
@ObjectType('VfdConnectionStatus')
export class VfdConnectionStatusDto {
  @Field()
  isConnected!: boolean;

  @Field({ nullable: true })
  lastTestedAt?: Date;

  @Field({ nullable: true })
  lastSuccessAt?: Date;

  @Field({ nullable: true })
  lastError?: string;

  @Field(() => Int, { nullable: true })
  latencyMs?: number;

  @Field(() => Int, { nullable: true })
  consecutiveFailures?: number;
}

/**
 * VFD Device output DTO
 */
@ObjectType('VfdDeviceOutput')
export class VfdDeviceDto {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String)
  brand!: VfdBrand;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field(() => String)
  protocol!: VfdProtocol;

  @Field(() => String)
  status!: VfdDeviceStatus;

  @Field({ nullable: true })
  location?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ID, { nullable: true })
  farmId?: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field(() => VfdConnectionStatusDto, { nullable: true })
  connectionStatus?: VfdConnectionStatusDto;

  @Field(() => Int)
  pollIntervalMs!: number;

  @Field()
  isPollingEnabled!: boolean;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

/**
 * Paginated VFD devices response
 *
 * Uses standard pagination response pattern (items, total, hasMore).
 */
@ObjectType('PaginatedVfdDevices')
export class PaginatedVfdDevicesDto extends PaginatedResponse(VfdDeviceDto) {}

/**
 * VFD device count by status
 */
@ObjectType('VfdDeviceCountByStatus')
export class VfdDeviceCountByStatusDto {
  @Field(() => Int)
  draft!: number;

  @Field(() => Int)
  pendingTest!: number;

  @Field(() => Int)
  testing!: number;

  @Field(() => Int)
  testFailed!: number;

  @Field(() => Int)
  active!: number;

  @Field(() => Int)
  suspended!: number;

  @Field(() => Int)
  offline!: number;
}

/**
 * Connection test result
 */
@ObjectType('ConnectionTestResult')
export class ConnectionTestResultDto {
  @Field()
  success!: boolean;

  @Field(() => Int, { nullable: true })
  latencyMs?: number;

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  errorCode?: string;

  @Field({ nullable: true })
  sampleData?: string;

  @Field()
  testedAt!: Date;
}

/**
 * VFD Brand Info output DTO
 */
@ObjectType('VfdBrandInfo')
export class VfdBrandInfoDto {
  @Field(() => String)
  code!: VfdBrand;

  @Field()
  name!: string;

  @Field({ nullable: true })
  logo?: string;

  @Field(() => [String])
  supportedProtocols!: VfdProtocol[];

  @Field(() => [String])
  modelSeries!: string[];
}

/**
 * Protocol schema output DTO
 */
@ObjectType('VfdProtocolSchema')
export class VfdProtocolSchemaDto {
  @Field(() => String)
  protocol!: VfdProtocol;

  @Field()
  name!: string;

  @Field()
  description!: string;

  @Field(() => String)
  connectionType!: 'serial' | 'ethernet';

  @Field(() => [VfdProtocolFieldDto])
  fields!: VfdProtocolFieldDto[];
}

/**
 * Protocol field definition
 */
@ObjectType('VfdProtocolField')
export class VfdProtocolFieldDto {
  @Field()
  name!: string;

  @Field()
  label!: string;

  @Field()
  type!: string;

  @Field()
  required!: boolean;

  @Field({ nullable: true })
  defaultValue?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => [String], { nullable: true })
  options?: string[];

  @Field(() => Int, { nullable: true })
  min?: number;

  @Field(() => Int, { nullable: true })
  max?: number;
}
