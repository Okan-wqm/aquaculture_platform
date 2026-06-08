import { InputType, Field, ObjectType, ID, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  MaxLength,
  IsArray,
  ValidateNested,
  IsNotEmpty,
  IsInt,
  IsEnum,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GraphQLJSON } from 'graphql-scalars';

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
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceName?: string;

  @Field({ nullable: true, description: 'Device description or location' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @Field(() => DeviceModel, { nullable: true, description: 'Hardware model' })
  @IsOptional()
  @IsEnum(DeviceModel)
  deviceModel?: DeviceModel;

  @Field({ nullable: true, description: 'Site to assign device to' })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true, description: 'Device serial number' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
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

  /**
   * Plaintext provisioning token — shown exactly once at device creation.
   * The caller must store it securely; it cannot be retrieved again.
   * It is required to download the installer script and to activate the device.
   */
  @Field()
  provisioningToken!: string;
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
  mqtt_tls_enabled?: boolean;
  provisioning_blob_b64?: string;
  provisioning_signature_b64?: string;
  provisioning_key_epoch?: number;
  provisioning_bundle_version?: number;
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
  mqttTlsEnabled: boolean;
}

// ============================================
// Tenant Provisioning Key Types
// ============================================

/**
 * Input for creating a tenant-level provisioning key
 * Allows multiple devices to register with a single key
 */
@InputType()
export class CreateTenantKeyInput {
  @Field({ nullable: true, description: 'Human-readable name for this key (e.g., "Production Line Installer")' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @Field(() => Int, { nullable: true, description: 'Maximum number of devices that can register with this key (null = unlimited)' })
  @IsOptional()
  @IsInt({ message: 'maxDevices must be an integer' })
  @Min(1, { message: 'maxDevices must be at least 1' })
  maxDevices?: number;

  @Field({ nullable: true, defaultValue: false, description: 'If true, devices are automatically set to ACTIVE (no manual approval needed)' })
  @IsOptional()
  autoApprove?: boolean;

  @Field({ nullable: true, description: 'Default site to assign registered devices to' })
  @IsOptional()
  @IsUUID()
  defaultSiteId?: string;

  @Field(() => Int, { nullable: true, description: 'Expiry in days from now (null = never expires)' })
  @IsOptional()
  @IsInt({ message: 'expiresInDays must be an integer' })
  @Min(1, { message: 'expiresInDays must be at least 1' })
  expiresInDays?: number;
}

/**
 * Response after creating a tenant provisioning key
 */
@ObjectType()
export class TenantKeyResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  keyToken!: string;

  @Field()
  installerUrl!: string;

  @Field()
  installerCommand!: string;

  @Field({ nullable: true })
  expiresAt?: Date;

  @Field(() => Int, { nullable: true })
  maxDevices?: number;

  @Field()
  autoApprove!: boolean;
}

// ============================================
// Self-Registration Types (REST API)
// ============================================

/**
 * Self-register request from agent (REST API)
 * Agent sends this after being installed via tenant installer
 */
export class SelfRegisterRequest {
  @IsString()
  @IsNotEmpty({ message: 'Tenant token is required' })
  @MaxLength(128, { message: 'Tenant token too long' })
  tenant_token!: string;

  @ValidateNested()
  @Type(() => DeviceFingerprint)
  fingerprint!: DeviceFingerprint;

  @IsString()
  @IsNotEmpty({ message: 'Agent version is required' })
  @MaxLength(50)
  agent_version!: string;
}

/**
 * Self-register response to agent (REST API)
 */
export interface SelfRegisterResponse {
  success: boolean;
  device_id: string;
  device_code: string;
  mqtt_broker: string;
  mqtt_port: number;
  mqtt_username: string;
  mqtt_password: string;
  tenant_id: string;
  mqtt_tls_enabled?: boolean;
  provisioning_blob_b64?: string;
  provisioning_signature_b64?: string;
  provisioning_key_epoch?: number;
  provisioning_bundle_version?: number;
  config?: Record<string, unknown>;
}

/**
 * Installer script variables for tenant-level installer
 */
export interface TenantInstallerScriptVariables {
  tenantToken: string;
  apiUrl: string;
  agentVersion: string;
  mqttPort: number;
  mqttTlsEnabled: boolean;
}

/**
 * DeviceEvent connection for pagination
 */
@ObjectType()
export class DeviceEventConnection {
  @Field(() => [DeviceEventItem])
  items!: DeviceEventItem[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;
}

@ObjectType()
export class DeviceEventItem {
  @Field(() => ID)
  id!: string;

  @Field({ nullable: true })
  deviceId?: string;

  @Field()
  eventType!: string;

  @Field()
  severity!: string;

  @Field()
  message!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  createdAt!: Date;
}
