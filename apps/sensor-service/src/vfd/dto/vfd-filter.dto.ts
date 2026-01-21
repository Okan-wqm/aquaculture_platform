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
 */
@InputType('VfdPaginationInput')
export class VfdPaginationDto {
  @Field(() => Int, { nullable: true, defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @Field({ nullable: true, defaultValue: 'createdAt' })
  @IsOptional()
  @IsString()
  @IsEnum(['name', 'brand', 'status', 'createdAt', 'updatedAt'])
  sortBy?: string;

  @Field({ nullable: true, defaultValue: 'DESC' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

/**
 * VFD Device output DTO
 */
@ObjectType('VfdDevice')
export class VfdDeviceDto {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => String)
  brand: VfdBrand;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field(() => String)
  protocol: VfdProtocol;

  @Field(() => String)
  status: VfdDeviceStatus;

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
  pollIntervalMs: number;

  @Field()
  isPollingEnabled: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

/**
 * VFD Connection Status output DTO
 */
@ObjectType('VfdConnectionStatus')
export class VfdConnectionStatusDto {
  @Field()
  isConnected: boolean;

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
 * Paginated VFD devices response
 */
@ObjectType('PaginatedVfdDevices')
export class PaginatedVfdDevicesDto {
  @Field(() => [VfdDeviceDto])
  items: VfdDeviceDto[];

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  totalPages: number;
}

/**
 * VFD device count by status
 */
@ObjectType('VfdDeviceCountByStatus')
export class VfdDeviceCountByStatusDto {
  @Field(() => Int)
  draft: number;

  @Field(() => Int)
  pendingTest: number;

  @Field(() => Int)
  testing: number;

  @Field(() => Int)
  testFailed: number;

  @Field(() => Int)
  active: number;

  @Field(() => Int)
  suspended: number;

  @Field(() => Int)
  offline: number;
}

/**
 * Connection test result
 */
@ObjectType('ConnectionTestResult')
export class ConnectionTestResultDto {
  @Field()
  success: boolean;

  @Field(() => Int, { nullable: true })
  latencyMs?: number;

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  errorCode?: string;

  @Field({ nullable: true })
  sampleData?: string;

  @Field()
  testedAt: Date;
}

/**
 * VFD Brand Info output DTO
 */
@ObjectType('VfdBrandInfo')
export class VfdBrandInfoDto {
  @Field(() => String)
  code: VfdBrand;

  @Field()
  name: string;

  @Field({ nullable: true })
  logo?: string;

  @Field(() => [String])
  supportedProtocols: VfdProtocol[];

  @Field(() => [String])
  modelSeries: string[];
}

/**
 * Protocol schema output DTO
 */
@ObjectType('VfdProtocolSchema')
export class VfdProtocolSchemaDto {
  @Field(() => String)
  protocol: VfdProtocol;

  @Field()
  name: string;

  @Field()
  description: string;

  @Field(() => String)
  connectionType: 'serial' | 'ethernet';

  @Field(() => [VfdProtocolFieldDto])
  fields: VfdProtocolFieldDto[];
}

/**
 * Protocol field definition
 */
@ObjectType('VfdProtocolField')
export class VfdProtocolFieldDto {
  @Field()
  name: string;

  @Field()
  label: string;

  @Field()
  type: string;

  @Field()
  required: boolean;

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
