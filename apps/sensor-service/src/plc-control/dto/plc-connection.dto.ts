import { InputType, Field, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsUUID,
  IsUrl,
  IsInt,
  Min,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  PlcConnectionStatus,
  PlcSecurityMode,
  PlcAuthMode,
} from '../entities/plc-connection.entity';

/**
 * Input DTO for creating a new PLC connection
 */
@InputType('CreatePlcConnectionInput')
export class CreatePlcConnectionDto {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @IsUrl({ protocols: ['opc.tcp'], require_protocol: true })
  endpointUrl!: string;

  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => String, { nullable: true, defaultValue: PlcSecurityMode.NONE })
  @IsOptional()
  @IsEnum(PlcSecurityMode)
  securityMode?: PlcSecurityMode;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  securityPolicy?: string;

  @Field(() => String, { nullable: true, defaultValue: PlcAuthMode.ANONYMOUS })
  @IsOptional()
  @IsEnum(PlcAuthMode)
  authMode?: PlcAuthMode;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  password?: string;

  @Field(() => Int, { nullable: true, defaultValue: 1000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60000)
  publishingIntervalMs?: number;

  @Field(() => Int, { nullable: true, defaultValue: 500 })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(60000)
  samplingIntervalMs?: number;

  @Field(() => Int, { nullable: true, defaultValue: 60000 })
  @IsOptional()
  @IsInt()
  @Min(5000)
  @Max(3600000)
  sessionTimeoutMs?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  parametersNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  telemetryNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  alarmsNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  statusNodeId?: string;
}

/**
 * Input DTO for updating a PLC connection
 */
@InputType('UpdatePlcConnectionInput')
export class UpdatePlcConnectionDto {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['opc.tcp'], require_protocol: true })
  endpointUrl?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(PlcSecurityMode)
  securityMode?: PlcSecurityMode;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  securityPolicy?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(PlcAuthMode)
  authMode?: PlcAuthMode;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  password?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60000)
  publishingIntervalMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(60000)
  samplingIntervalMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(5000)
  @Max(3600000)
  sessionTimeoutMs?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  parametersNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  telemetryNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  alarmsNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  statusNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  isActive?: boolean;
}

/**
 * Filter input for querying PLC connections
 */
@InputType('PlcConnectionFilterInput')
export class PlcConnectionFilterDto {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(PlcConnectionStatus)
  status?: PlcConnectionStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

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
  isActive?: boolean;
}

/**
 * Pagination input for PLC queries
 */
@InputType('PlcPaginationInput')
export class PlcPaginationDto {
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
  sortBy?: string;

  @Field({ nullable: true, defaultValue: 'DESC' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

/**
 * Paginated PLC connections response
 */
@ObjectType('PaginatedPlcConnections')
export class PaginatedPlcConnectionsDto {
  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  totalPages!: number;
}

/**
 * PLC connection count by status
 */
@ObjectType('PlcConnectionCountByStatus')
export class PlcConnectionCountByStatusDto {
  @Field(() => Int)
  online!: number;

  @Field(() => Int)
  offline!: number;

  @Field(() => Int)
  connecting!: number;

  @Field(() => Int)
  error!: number;
}

/**
 * Connection test result
 */
@ObjectType('PlcConnectionTestResult')
export class PlcConnectionTestResultDto {
  @Field()
  success!: boolean;

  @Field(() => Int, { nullable: true })
  latencyMs?: number;

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  errorCode?: string;

  @Field({ nullable: true })
  serverInfo?: string;

  @Field()
  testedAt!: Date;
}
