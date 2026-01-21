import { InputType, Field, ID, ObjectType, registerEnumType, Float, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsOptional, IsInt, IsString, IsEnum, IsUUID, IsBoolean, IsNumber, IsNotEmpty, IsObject, IsArray, ValidateNested } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { SensorType, SensorRegistrationStatus, SensorConnectionStatus, SensorRole } from '../../database/entities/sensor.entity';

import { CreateDataChannelInput, DataChannelType } from './data-channel.dto';

// Register enums
registerEnumType(SensorType, {
  name: 'SensorType',
  description: 'Type of sensor',
});

registerEnumType(SensorRegistrationStatus, {
  name: 'SensorRegistrationStatus',
  description: 'Sensor registration status',
});

registerEnumType(SensorRole, {
  name: 'SensorRole',
  description: 'Sensor role - parent device or child sensor',
});

// Input Types
@InputType()
export class RegisterSensorInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field(() => SensorType)
  @IsEnum(SensorType)
  type: SensorType;

  @Field()
  @IsNotEmpty()
  @IsString()
  protocolCode: string;

  @Field(() => GraphQLJSON)
  @IsObject()
  protocolConfiguration: object;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  manufacturer?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  model?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  farmId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  // New location hierarchy fields
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  systemId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  location?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  metadata?: object;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  skipConnectionTest?: boolean;

  @Field(() => [CreateDataChannelInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateDataChannelInput)
  dataChannels?: CreateDataChannelInput[];
}

@InputType()
export class UpdateSensorProtocolInput {
  @Field(() => ID)
  sensorId: string;

  @Field({ nullable: true })
  protocolCode?: string;

  @Field(() => GraphQLJSON)
  protocolConfiguration: object;
}

@InputType()
export class UpdateSensorInfoInput {
  @Field(() => ID)
  sensorId: string;

  @Field({ nullable: true })
  name?: string;

  @Field(() => SensorType, { nullable: true })
  type?: SensorType;

  @Field({ nullable: true })
  manufacturer?: string;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ID, { nullable: true })
  farmId?: string;

  @Field(() => ID, { nullable: true })
  pondId?: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  // New location hierarchy fields
  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field(() => ID, { nullable: true })
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  systemId?: string;

  @Field(() => ID, { nullable: true })
  equipmentId?: string;

  @Field({ nullable: true })
  location?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: object;
}

// Output Types
@ObjectType()
export class SensorConnectionStatusType {
  @Field()
  isConnected: boolean;

  @Field({ nullable: true })
  lastTestedAt?: Date;

  @Field({ nullable: true })
  lastError?: string;

  @Field({ nullable: true })
  latency?: number;
}

@ObjectType()
export class RegisteredSensorType {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => SensorType)
  type: SensorType;

  @Field()
  protocolCode: string;

  @Field(() => GraphQLJSON)
  protocolConfiguration: object;

  @Field(() => SensorConnectionStatusType, { nullable: true })
  connectionStatus?: SensorConnectionStatusType;

  @Field(() => SensorRegistrationStatus)
  registrationStatus: SensorRegistrationStatus;

  @Field({ nullable: true })
  manufacturer?: string;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ID, { nullable: true })
  farmId?: string;

  @Field(() => ID, { nullable: true })
  pondId?: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  // New location hierarchy fields
  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field(() => ID, { nullable: true })
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  systemId?: string;

  @Field(() => ID, { nullable: true })
  equipmentId?: string;

  @Field({ nullable: true })
  location?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: object;

  @Field()
  tenantId: string;

  // Parent-child relationship fields
  @Field(() => ID, { nullable: true })
  parentId?: string;

  @Field({ nullable: true })
  isParentDevice?: boolean;

  @Field({ nullable: true })
  dataPath?: string;

  @Field(() => SensorRole, { nullable: true })
  sensorRole?: SensorRole;

  @Field(() => [DataChannelType], { nullable: true })
  dataChannels?: DataChannelType[];

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class SensorRegistrationResultType {
  @Field()
  success: boolean;

  @Field(() => RegisteredSensorType, { nullable: true })
  sensor?: RegisteredSensorType;

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  connectionTestPassed?: boolean;

  @Field({ nullable: true })
  latencyMs?: number;
}

@ObjectType()
export class ConnectionTestResultType {
  @Field()
  success: boolean;

  @Field({ nullable: true })
  latencyMs?: number;

  @Field({ nullable: true })
  error?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  sampleData?: object;

  @Field()
  testedAt: Date;
}

@ObjectType()
export class SensorListType {
  @Field(() => [RegisteredSensorType])
  items: RegisteredSensorType[];

  @Field()
  total: number;

  @Field()
  page: number;

  @Field()
  pageSize: number;

  @Field()
  totalPages: number;
}

// Filter and pagination inputs
@InputType()
export class SensorFilterInput {
  @Field(() => SensorType, { nullable: true })
  @IsOptional()
  @IsEnum(SensorType)
  type?: SensorType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  protocolCode?: string;

  @Field(() => SensorRegistrationStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SensorRegistrationStatus)
  registrationStatus?: SensorRegistrationStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  farmId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  // New location hierarchy filters
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  systemId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}

@InputType()
export class PaginationInput {
  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  page?: number;

  @Field(() => Int, { defaultValue: 20 })
  @IsOptional()
  @IsInt()
  pageSize?: number;
}

// Parent-Child Registration Types

@InputType()
export class AlertThresholdRangeInput {
  @Field(() => Float, { nullable: true })
  low?: number;

  @Field(() => Float, { nullable: true })
  high?: number;
}

@InputType()
export class SensorAlertThresholdsInput {
  @Field(() => AlertThresholdRangeInput, { nullable: true })
  warning?: AlertThresholdRangeInput;

  @Field(() => AlertThresholdRangeInput, { nullable: true })
  critical?: AlertThresholdRangeInput;
}

@InputType()
export class DisplaySettingsInput {
  @Field({ nullable: true, defaultValue: true })
  showOnDashboard?: boolean;

  @Field({ nullable: true })
  widgetType?: string;

  @Field({ nullable: true })
  color?: string;

  @Field({ nullable: true })
  sortOrder?: number;

  @Field({ nullable: true })
  decimalPlaces?: number;
}

@InputType()
export class RegisterParentDeviceInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  protocolCode: string;

  @Field(() => GraphQLJSON)
  @IsObject()
  protocolConfiguration: object;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  manufacturer?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  model?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  farmId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  // New location hierarchy fields
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  systemId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  location?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  metadata?: object;
}

@InputType()
export class RegisterChildSensorInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field(() => SensorType)
  @IsEnum(SensorType)
  type: SensorType;

  @Field()
  @IsNotEmpty()
  @IsString()
  dataPath: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  unit?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  minValue?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  maxValue?: number;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  calibrationEnabled?: boolean;

  @Field(() => Float, { nullable: true, defaultValue: 1.0 })
  @IsOptional()
  @IsNumber()
  calibrationMultiplier?: number;

  @Field(() => Float, { nullable: true, defaultValue: 0.0 })
  @IsOptional()
  @IsNumber()
  calibrationOffset?: number;

  @Field(() => SensorAlertThresholdsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => SensorAlertThresholdsInput)
  alertThresholds?: SensorAlertThresholdsInput;

  @Field(() => DisplaySettingsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => DisplaySettingsInput)
  displaySettings?: DisplaySettingsInput;
}

@InputType()
export class RegisterParentWithChildrenInput {
  @Field(() => RegisterParentDeviceInput)
  @ValidateNested()
  @Type(() => RegisterParentDeviceInput)
  parent: RegisterParentDeviceInput;

  @Field(() => [RegisterChildSensorInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegisterChildSensorInput)
  children: RegisterChildSensorInput[];

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  skipConnectionTest?: boolean;
}

// Output Types for Parent-Child

@ObjectType()
export class AlertThresholdRangeType {
  @Field(() => Float, { nullable: true })
  low?: number;

  @Field(() => Float, { nullable: true })
  high?: number;
}

@ObjectType()
export class SensorAlertThresholdsType {
  @Field(() => AlertThresholdRangeType, { nullable: true })
  warning?: AlertThresholdRangeType;

  @Field(() => AlertThresholdRangeType, { nullable: true })
  critical?: AlertThresholdRangeType;
}

@ObjectType()
export class DisplaySettingsType {
  @Field({ nullable: true })
  showOnDashboard?: boolean;

  @Field({ nullable: true })
  widgetType?: string;

  @Field({ nullable: true })
  color?: string;

  @Field({ nullable: true })
  sortOrder?: number;

  @Field({ nullable: true })
  decimalPlaces?: number;
}

@ObjectType()
export class ChildSensorType {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => SensorType)
  type: SensorType;

  @Field()
  dataPath: string;

  @Field({ nullable: true })
  unit?: string;

  @Field(() => Float, { nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  maxValue?: number;

  @Field({ nullable: true })
  calibrationEnabled?: boolean;

  @Field(() => Float, { nullable: true })
  calibrationMultiplier?: number;

  @Field(() => Float, { nullable: true })
  calibrationOffset?: number;

  @Field(() => SensorAlertThresholdsType, { nullable: true })
  alertThresholds?: SensorAlertThresholdsType;

  @Field(() => DisplaySettingsType, { nullable: true })
  displaySettings?: DisplaySettingsType;

  @Field(() => SensorRegistrationStatus)
  registrationStatus: SensorRegistrationStatus;

  @Field()
  tenantId: string;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class ParentDeviceType {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  protocolCode: string;

  @Field(() => GraphQLJSON)
  protocolConfiguration: object;

  @Field(() => SensorConnectionStatusType, { nullable: true })
  connectionStatus?: SensorConnectionStatusType;

  @Field(() => SensorRegistrationStatus)
  registrationStatus: SensorRegistrationStatus;

  @Field({ nullable: true })
  manufacturer?: string;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ID, { nullable: true })
  farmId?: string;

  @Field(() => ID, { nullable: true })
  pondId?: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  // New location hierarchy fields
  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field(() => ID, { nullable: true })
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  systemId?: string;

  @Field(() => ID, { nullable: true })
  equipmentId?: string;

  @Field({ nullable: true })
  location?: string;

  @Field(() => [ChildSensorType], { nullable: true })
  childSensors?: ChildSensorType[];

  @Field()
  tenantId: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class ParentWithChildrenResultType {
  @Field()
  success: boolean;

  @Field(() => ParentDeviceType, { nullable: true })
  parent?: ParentDeviceType;

  @Field(() => [ChildSensorType], { nullable: true })
  children?: ChildSensorType[];

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  connectionTestPassed?: boolean;

  @Field({ nullable: true })
  latencyMs?: number;
}
