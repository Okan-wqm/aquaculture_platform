import { InputType, Field, ObjectType, ID } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  MaxLength,
  IsArray,
  ValidateNested,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

import { DeviceModel } from '../entities/edge-device.entity';

// ============================================
// Input Types
// ============================================

/**
 * Input for creating a device with provisioning token
 */
@InputType()
export class CreateProvisionedDeviceInput {
  @Field({ nullable: true, description: 'Human-readable device name' })
  deviceName?: string;

  @Field({ nullable: true, description: 'Device description or location' })
  description?: string;

  @Field(() => DeviceModel, { nullable: true, description: 'Hardware model' })
  deviceModel?: DeviceModel;

  @Field({ nullable: true, description: 'Site to assign device to' })
  siteId?: string;

  @Field({ nullable: true, description: 'Device serial number' })
  serialNumber?: string;
}

// ============================================
// Output Types
// ============================================

/**
 * Response after creating a provisioned device
 */
@ObjectType()
export class ProvisionedDeviceResponse {
  @Field(() => ID)
  deviceId!: string;

  @Field()
  deviceCode!: string;

  @Field()
  installerUrl!: string;

  @Field()
  installerCommand!: string;

  @Field()
  tokenExpiresAt!: Date;

  @Field()
  status!: string;
}

/**
 * Response after regenerating a device token
 */
@ObjectType()
export class RegenerateTokenResponse {
  @Field(() => ID)
  deviceId!: string;

  @Field()
  deviceCode!: string;

  @Field()
  installerUrl!: string;

  @Field()
  installerCommand!: string;

  @Field()
  tokenExpiresAt!: Date;
}

// ============================================
// REST API Types (not GraphQL)
// ============================================

/**
 * Device fingerprint collected by agent
 * Validated class for security
 */
export class DeviceFingerprint {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cpuSerial?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  macAddresses?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  machineId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  hostname?: string;
}

/**
 * Activation request from agent (REST API)
 * SECURITY: All fields validated to prevent injection attacks
 */
export class DeviceActivationRequest {
  @IsUUID('4', { message: 'Invalid device ID format' })
  deviceId!: string;

  @IsString()
  @IsNotEmpty({ message: 'Token is required' })
  @MaxLength(500, { message: 'Token too long' })
  token!: string;

  @ValidateNested()
  @Type(() => DeviceFingerprint)
  fingerprint!: DeviceFingerprint;

  @IsString()
  @MaxLength(50)
  agentVersion!: string;
}

/**
 * Activation response to agent (REST API)
 * Note: Using snake_case for REST API compatibility (v1.1 spec)
 */
export interface DeviceActivationResponse {
  success: boolean;
  mqtt_broker: string;
  mqtt_port: number;
  mqtt_username: string;
  mqtt_password: string;
  tenant_id: string;
  device_code: string;
  config?: Record<string, unknown>;
}

/**
 * Error response for activation failures
 */
export interface ActivationErrorResponse {
  success: false;
  error: string;
  errorCode: ActivationErrorCode;
}

/**
 * Activation error codes
 */
export enum ActivationErrorCode {
  INVALID_TOKEN = 'INVALID_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_ALREADY_USED = 'TOKEN_ALREADY_USED',
  DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
  DEVICE_DECOMMISSIONED = 'DEVICE_DECOMMISSIONED',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * Installer script variables (for template rendering)
 */
export interface InstallerScriptVariables {
  deviceId: string;
  deviceCode: string;
  provisioningToken: string;
  apiUrl: string;
  agentVersion: string;
  mqttBroker: string;
  mqttPort: number;
}
