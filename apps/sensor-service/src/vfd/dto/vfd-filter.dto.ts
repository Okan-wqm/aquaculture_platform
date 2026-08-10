import { InputType, Field, Int, ObjectType, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsUUID,
  IsInt,
  IsIn,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { VfdBrand, VfdProtocol, VfdDeviceStatus } from '../entities/vfd.enums';
import { StandardPaginationInput, StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';

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

  /**
   * Units are no longer a column on the drive, so this filter resolves THROUGH the
   * attested binding: it matches drives whose driven equipment currently serves
   * this unit. A drive on a pump matches nothing here, which is correct.
   */
  @Field(() => ID, {
    nullable: true,
    description: 'Drives whose driven equipment currently serves this unit',
  })
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
 * Uses standard offset/limit pattern from @aquaculture/backend-common.
 * Extends PaginationInput with VFD-specific sortBy validation.
 */
@InputType('VfdPaginationInput')
export class VfdPaginationDto extends StandardPaginationInput {
  @Field({ nullable: true, defaultValue: 'createdAt', description: 'Field to sort by (name, brand, status, createdAt, updatedAt)' })
  @IsOptional()
  @IsString()
  @IsIn(['name', 'brand', 'status', 'createdAt', 'updatedAt'])
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

  // No `tankId` here. This DTO is a flat projection of the device row, and the
  // unit a drive serves is no longer a property of that row — it is derived
  // through the binding, per device. Emitting it here would mean either a lie
  // (always null) or an N+1 the list path cannot afford. `VfdDevice.tankId`
  // (the per-device type) resolves it truthfully.

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
 * Paginated VFD devices response (standard pagination).
 */
@ObjectType('PaginatedVfdDevices')
export class PaginatedVfdDevicesDto extends StandardPaginatedResponse(VfdDeviceDto) {}

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

/**
 * Paginated VFD devices response matching frontend expectations.
 * Uses standard pagination with full metadata.
 */
@ObjectType('PaginatedVfdDeviceList')
export class PaginatedVfdDeviceListDto extends StandardPaginatedResponse(VfdDeviceDto) {}

/**
 * VFD Registration Result wrapping device + connection test outcome.
 * Matches frontend VfdRegistrationResult interface.
 */
@ObjectType('VfdRegistrationResult')
export class VfdRegistrationResultDto {
  @Field()
  success!: boolean;

  @Field(() => VfdDeviceDto, { nullable: true })
  vfdDevice?: VfdDeviceDto;

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  connectionTestPassed?: boolean;

  @Field(() => Int, { nullable: true })
  latencyMs?: number;
}

/**
 * Input for testing VFD connection (before device is registered).
 * Frontend sends protocol + configuration directly.
 */
@InputType('TestVfdConnectionInput')
export class TestVfdConnectionInputDto {
  @Field(() => String)
  @IsEnum(VfdProtocol)
  protocol!: VfdProtocol;

  @Field(() => GraphQLJSON)
  configuration!: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(VfdBrand)
  brand?: VfdBrand;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  modelSeries?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(30000)
  timeout?: number;
}

/**
 * Device info returned in connection test result
 */
@ObjectType('VfdDeviceInfo')
export class VfdDeviceInfoDto {
  @Field({ nullable: true })
  manufacturer?: string;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  serialNumber?: string;
}

/**
 * Connection diagnostics
 */
@ObjectType('VfdDiagnostics')
export class VfdDiagnosticsDto {
  @Field(() => Int)
  communicationErrors!: number;

  @Field(() => Int)
  retries!: number;

  @Field(() => Int)
  packetsSent!: number;

  @Field(() => Int)
  packetsReceived!: number;

  @Field(() => Int)
  averageLatency!: number;

  @Field(() => Int)
  maxLatency!: number;
}

/**
 * Extended connection test result matching frontend VfdConnectionTestResult.
 */
@ObjectType('VfdConnectionTestResult')
export class VfdConnectionTestResultDto {
  @Field()
  success!: boolean;

  @Field(() => Int, { nullable: true })
  latencyMs?: number;

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  errorCode?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  sampleData?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  statusBits?: Record<string, unknown>;

  @Field({ nullable: true })
  firmwareVersion?: string;

  @Field(() => VfdDeviceInfoDto, { nullable: true })
  deviceInfo?: VfdDeviceInfoDto;

  @Field()
  testedAt!: Date;

  @Field(() => VfdDiagnosticsDto, { nullable: true })
  diagnostics?: VfdDiagnosticsDto;
}

/**
 * VFD fleet statistics (total, active, inactive, faulted, maintenance, byBrand, byProtocol, byStatus).
 * Matches frontend VfdStats interface.
 */
@ObjectType('VfdStats')
export class VfdStatsDto {
  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  active!: number;

  @Field(() => Int)
  inactive!: number;

  @Field(() => Int)
  faulted!: number;

  @Field(() => Int)
  maintenance!: number;

  @Field(() => GraphQLJSON)
  byBrand!: Record<string, number>;

  @Field(() => GraphQLJSON)
  byProtocol!: Record<string, number>;

  @Field(() => GraphQLJSON)
  byStatus!: Record<string, number>;
}
