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
  Matches,
  IsIn,
} from 'class-validator';

import {
  PlcConnection,
  PlcConnectionStatus,
  PlcSecurityMode,
  PlcAuthMode,
} from '../entities/plc-connection.entity';
import { StandardPaginationInput, StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';

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
  @IsIn(['None', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsPss'], { message: 'securityPolicy must be one of: None, Basic256Sha256, Aes128_Sha256_RsaOaep, Aes256_Sha256_RsPss' })
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

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  @Matches(/^-----BEGIN CERTIFICATE-----/, { message: 'clientCertificate must be PEM-encoded (BEGIN CERTIFICATE)' })
  clientCertificate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  @Matches(/^-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/, { message: 'clientPrivateKey must be PEM-encoded (BEGIN PRIVATE KEY)' })
  clientPrivateKey?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  @Matches(/^-----BEGIN CERTIFICATE-----/, { message: 'serverCertificate must be PEM-encoded (BEGIN CERTIFICATE)' })
  serverCertificate?: string;

  @Field(() => Int, { nullable: true, defaultValue: 5000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  connectTimeoutMs?: number;

  @Field(() => Int, { nullable: true, defaultValue: 60000 })
  @IsOptional()
  @IsInt()
  @Min(5000)
  @Max(300000)
  requestTimeoutMs?: number;

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  autoReconnect?: boolean;

  @Field(() => Int, { nullable: true, defaultValue: -1 })
  @IsOptional()
  @IsInt()
  @Min(-1)
  @Max(1000)
  maxReconnectAttempts?: number;

  @Field(() => Int, { nullable: true, defaultValue: 1000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60000)
  reconnectDelayMs?: number;

  @Field(() => Int, { nullable: true, defaultValue: 30000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(300000)
  maxReconnectDelayMs?: number;

  @Field(() => Int, { nullable: true, defaultValue: 5000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  keepAliveIntervalMs?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^opc\.tcp:\/\//, { message: 'failoverEndpointUrl must start with opc.tcp://' })
  failoverEndpointUrl?: string;

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
  @Matches(/^(ns=\d+;)?.[sib]=/, { message: 'parametersNodeId must be a valid OPC UA Node ID (e.g. ns=2;s=MyNode)' })
  parametersNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(ns=\d+;)?.[sib]=/, { message: 'telemetryNodeId must be a valid OPC UA Node ID (e.g. ns=2;s=MyNode)' })
  telemetryNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(ns=\d+;)?.[sib]=/, { message: 'alarmsNodeId must be a valid OPC UA Node ID (e.g. ns=2;s=MyNode)' })
  alarmsNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(ns=\d+;)?.[sib]=/, { message: 'statusNodeId must be a valid OPC UA Node ID (e.g. ns=2;s=MyNode)' })
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
  @IsIn(['None', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsPss'], { message: 'securityPolicy must be one of: None, Basic256Sha256, Aes128_Sha256_RsaOaep, Aes256_Sha256_RsPss' })
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

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  @Matches(/^-----BEGIN CERTIFICATE-----/, { message: 'clientCertificate must be PEM-encoded (BEGIN CERTIFICATE)' })
  clientCertificate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  @Matches(/^-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/, { message: 'clientPrivateKey must be PEM-encoded (BEGIN PRIVATE KEY)' })
  clientPrivateKey?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  @Matches(/^-----BEGIN CERTIFICATE-----/, { message: 'serverCertificate must be PEM-encoded (BEGIN CERTIFICATE)' })
  serverCertificate?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  connectTimeoutMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(5000)
  @Max(300000)
  requestTimeoutMs?: number;

  @Field({ nullable: true })
  @IsOptional()
  autoReconnect?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(-1)
  @Max(1000)
  maxReconnectAttempts?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60000)
  reconnectDelayMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(300000)
  maxReconnectDelayMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  keepAliveIntervalMs?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^opc\.tcp:\/\//, { message: 'failoverEndpointUrl must start with opc.tcp://' })
  failoverEndpointUrl?: string;

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
  @Matches(/^(ns=\d+;)?.[sib]=/, { message: 'parametersNodeId must be a valid OPC UA Node ID (e.g. ns=2;s=MyNode)' })
  parametersNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(ns=\d+;)?.[sib]=/, { message: 'telemetryNodeId must be a valid OPC UA Node ID (e.g. ns=2;s=MyNode)' })
  telemetryNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(ns=\d+;)?.[sib]=/, { message: 'alarmsNodeId must be a valid OPC UA Node ID (e.g. ns=2;s=MyNode)' })
  alarmsNodeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(ns=\d+;)?.[sib]=/, { message: 'statusNodeId must be a valid OPC UA Node ID (e.g. ns=2;s=MyNode)' })
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
export class PlcPaginationDto extends StandardPaginationInput {}

/**
 * Paginated PLC connections response
 */
@ObjectType('PaginatedPlcConnections')
export class PaginatedPlcConnectionsDto extends StandardPaginatedResponse(PlcConnection) {}

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

/**
 * Discovered OPC UA endpoint from server
 */
@ObjectType('DiscoveredOpcUaEndpoint')
export class DiscoveredEndpointDto {
  @Field()
  endpointUrl!: string;

  @Field()
  securityMode!: string;

  @Field()
  securityPolicy!: string;

  @Field(() => Int)
  securityLevel!: number;

  @Field({ nullable: true })
  serverCertificate?: string;

  @Field({ nullable: true })
  transportProfileUri?: string;
}

/**
 * Node browse result from OPC UA server
 */
@ObjectType('OpcUaNodeBrowseResult')
export class NodeBrowseResultDto {
  @Field()
  nodeId!: string;

  @Field()
  browseName!: string;

  @Field()
  displayName!: string;

  @Field()
  nodeClass!: string;

  @Field({ nullable: true })
  dataType?: string;

  @Field()
  hasChildren!: boolean;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  value?: string;
}

/**
 * Historical data point
 */
@ObjectType('OpcUaHistoricalDataPoint')
export class HistoricalDataPointDto {
  @Field()
  timestamp!: Date;

  @Field({ nullable: true })
  value?: string; // JSON serialized value
}

/**
 * Input for reading historical data
 */
@InputType('ReadHistoricalDataInput')
export class ReadHistoricalDataInputDto {
  @Field()
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @Field()
  startTime!: Date;

  @Field()
  endTime!: Date;

  @Field(() => Int, { nullable: true, defaultValue: 1000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxValues?: number;
}

/**
 * Method argument input
 */
@InputType('OpcUaMethodArgumentInput')
export class MethodArgumentInputDto {
  @Field()
  @IsString()
  @IsNotEmpty()
  dataType!: string;

  @Field()
  @IsString()
  value!: string; // JSON serialized value
}

/**
 * Method call input
 */
@InputType('OpcUaCallMethodInput')
export class CallMethodInputDto {
  @Field()
  @IsString()
  @IsNotEmpty()
  objectId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  methodId!: string;

  @Field(() => [MethodArgumentInputDto], { nullable: true })
  @IsOptional()
  inputArguments?: MethodArgumentInputDto[];
}

/**
 * Method call result
 */
@ObjectType('OpcUaMethodCallResult')
export class MethodCallResultDto {
  @Field(() => Int)
  statusCode!: number;

  @Field(() => [String])
  outputArguments!: string[];
}

/**
 * Write node value input
 */
@InputType('WriteOpcUaNodeInput')
export class WriteNodeInputDto {
  @Field()
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  value!: string; // JSON serialized

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  dataType?: string;
}
