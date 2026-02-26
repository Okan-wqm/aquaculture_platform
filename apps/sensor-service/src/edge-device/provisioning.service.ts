import * as crypto from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  CreateProvisionedDeviceInput,
  ProvisionedDeviceResponse,
  RegenerateTokenResponse,
  DeviceActivationRequest,
  DeviceActivationResponse,
  ActivationErrorCode,
  InstallerScriptVariables,
  CreateTenantKeyInput,
  TenantKeyResponse,
  SelfRegisterRequest,
  SelfRegisterResponse,
  TenantInstallerScriptVariables,
} from './dto/provisioning.dto';
import {
  EdgeDevice,
  DeviceLifecycleState,
  DeviceModel,
} from './entities/edge-device.entity';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { DeviceEventType, DeviceEventSeverity } from './entities/device-event.entity';
import { MqttAuthService } from './mqtt-auth.service';
import { InstallerScriptService } from './installer-script.service';
import { TenantKeyService } from './tenant-key.service';
import { DeviceEventService } from './device-event.service';

/**
 * Provisioning Service
 * Handles zero-touch device provisioning workflow.
 * Delegates script generation, tenant key management, and event logging
 * to focused sub-services.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly TOKEN_TTL_HOURS: number;

  constructor(
    @InjectRepository(EdgeDevice)
    private readonly deviceRepository: Repository<EdgeDevice>,
    private readonly configService: ConfigService,
    private readonly mqttAuthService: MqttAuthService,
    private readonly installerScriptService: InstallerScriptService,
    private readonly tenantKeyService: TenantKeyService,
    private readonly deviceEventService: DeviceEventService,
  ) {
    this.TOKEN_TTL_HOURS = this.configService.get<number>('PROVISIONING_TOKEN_TTL_HOURS', 24);
  }

  /**
   * Generate a cryptographically secure provisioning token
   */
  generateProvisioningToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate device code from model and random suffix
   */
  generateDeviceCode(model?: DeviceModel): string {
    const prefix = this.getDeviceCodePrefix(model);
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${suffix}`;
  }

  /**
   * Get device code prefix based on model
   */
  private getDeviceCodePrefix(model?: DeviceModel): string {
    switch (model) {
      case DeviceModel.REVOLUTION_PI_CONNECT_4:
      case DeviceModel.REVOLUTION_PI_COMPACT:
        return 'RPI';
      case DeviceModel.RASPBERRY_PI_4:
      case DeviceModel.RASPBERRY_PI_5:
        return 'PI';
      case DeviceModel.INDUSTRIAL_PC:
        return 'IPC';
      default:
        return 'EDGE';
    }
  }

  /**
   * Create a new device with provisioning token
   */
  async createProvisionedDevice(
    tenantId: string,
    input: CreateProvisionedDeviceInput,
    createdBy?: string,
  ): Promise<ProvisionedDeviceResponse> {
    // Generate a device code. Uniqueness is enforced by the DB unique constraint
    // (caught as a 23505 error below). A pre-check loop would create a TOCTOU race
    // without providing meaningful safety.
    const deviceCode = this.generateDeviceCode(input.deviceModel);

    // Generate provisioning token
    const provisioningToken = this.generateProvisioningToken();
    const tokenExpiresAt = new Date(Date.now() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000);

    // Generate MQTT client ID
    const mqttClientId = `edge-${tenantId.substring(0, 8)}-${deviceCode}`.toLowerCase();

    // Create device
    const device = this.deviceRepository.create({
      tenantId,
      deviceCode,
      deviceName: input.deviceName || deviceCode,
      deviceModel: input.deviceModel || DeviceModel.CUSTOM,
      serialNumber: input.serialNumber,
      description: input.description,
      siteId: input.siteId,
      lifecycleState: DeviceLifecycleState.REGISTERED,
      provisioningToken,
      tokenExpiresAt,
      mqttClientId,
      isOnline: false,
      securityLevel: 2,
      createdBy,
    });

    let saved: EdgeDevice;
    try {
      saved = await this.deviceRepository.save(device);
    } catch (error: any) {
      if (error?.code === '23505') { // PostgreSQL unique violation
        throw new ConflictException('Device code conflict, please retry');
      }
      throw error;
    }
    this.logger.log(`Created provisioned device ${deviceCode} for tenant ${tenantId}`);

    return await this.buildProvisioningResponse(saved, provisioningToken);
  }

  /**
   * Regenerate provisioning token for an existing device
   */
  async regenerateToken(
    deviceId: string,
    tenantId: string,
  ): Promise<RegenerateTokenResponse> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    // Only allow regeneration for devices that haven't been activated
    if (device.tokenUsedAt) {
      throw new ConflictException('Cannot regenerate token for already activated device');
    }

    // Don't allow regeneration for decommissioned devices
    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      throw new BadRequestException('Cannot regenerate token for decommissioned device');
    }

    // Generate new token
    const provisioningToken = this.generateProvisioningToken();
    const tokenExpiresAt = new Date(Date.now() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000);

    await this.deviceRepository.update(device.id, {
      provisioningToken,
      tokenExpiresAt,
    });
    device.provisioningToken = provisioningToken;
    device.tokenExpiresAt = tokenExpiresAt;
    const saved = device;
    this.logger.log(`Regenerated token for device ${device.deviceCode}`);

    return {
      deviceId: saved.id,
      deviceCode: saved.deviceCode,
      installerUrl: await this.installerScriptService.buildInstallerUrl(saved.deviceCode, provisioningToken),
      installerCommand: await this.installerScriptService.buildInstallerCommand(saved.deviceCode, provisioningToken),
      tokenExpiresAt,
    };
  }

  /**
   * Generate installer script for a device.
   *
   * SECURITY: The caller must supply the provisioning token so that knowing the device
   * code alone is insufficient to retrieve the plaintext token embedded in the script.
   * The token acts as a shared secret that authorises script generation.
   *
   * @param deviceCode         - Public device identifier
   * @param provisioningToken  - Plaintext token issued at device creation (acts as auth credential)
   */
  async generateInstallerScript(deviceCode: string, provisioningToken: string): Promise<string> {
    // Find device by code (cross-tenant lookup for public endpoint)
    const device = await this.deviceRepository.findOne({
      where: { deviceCode },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceCode} not found`);
    }

    // Check if token is valid
    if (!device.provisioningToken) {
      throw new BadRequestException('Device has no provisioning token');
    }

    // Require the caller to present the correct provisioning token
    if (device.provisioningToken !== provisioningToken) {
      throw new UnauthorizedException('Invalid provisioning token');
    }

    if (device.tokenUsedAt) {
      throw new ConflictException('Device has already been activated');
    }

    if (device.tokenExpiresAt && device.tokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Provisioning token has expired');
    }

    const config = await this.installerScriptService.getProvisioningConfig();

    const variables: InstallerScriptVariables = {
      deviceId: device.id,
      deviceCode: device.deviceCode,
      provisioningToken: device.provisioningToken,
      apiUrl: config.apiBaseUrl,
      agentVersion: config.agentVersion,
      mqttBroker: config.mqttBroker,
      mqttPort: config.mqttPort,
    };

    return this.installerScriptService.renderInstallerScript(variables, config);
  }

  /**
   * Activate a device (called by agent)
   */
  async activateDevice(
    request: DeviceActivationRequest,
  ): Promise<DeviceActivationResponse> {
    const { deviceId, token, fingerprint, agentVersion } = request;

    // Find device
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      this.logger.warn(`Activation failed: device ${deviceId} not found`);
      throw new NotFoundException({
        success: false,
        error: 'Device not found',
        errorCode: ActivationErrorCode.DEVICE_NOT_FOUND,
      });
    }

    // Check if device is decommissioned
    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      throw new BadRequestException({
        success: false,
        error: 'Device has been decommissioned',
        errorCode: ActivationErrorCode.DEVICE_DECOMMISSIONED,
      });
    }

    // Check if token is already used
    if (device.tokenUsedAt) {
      this.logger.warn(`Activation failed: token already used for device ${device.deviceCode}`);
      throw new ConflictException({
        success: false,
        error: 'Device has already been activated',
        errorCode: ActivationErrorCode.TOKEN_ALREADY_USED,
      });
    }

    // Validate token
    // Hash both tokens to get constant-length buffers, preventing length-based timing leaks
    const tokenHash = crypto.createHash('sha256').update(token).digest();
    const storedHash = crypto.createHash('sha256').update(device.provisioningToken || '').digest();
    if (!device.provisioningToken || !crypto.timingSafeEqual(tokenHash, storedHash)) {
      this.logger.warn(`Activation failed: invalid token for device ${device.deviceCode}`);
      throw new UnauthorizedException({
        success: false,
        error: 'Invalid provisioning token',
        errorCode: ActivationErrorCode.INVALID_TOKEN,
      });
    }

    // Check token expiry
    if (device.tokenExpiresAt && device.tokenExpiresAt < new Date()) {
      this.logger.warn(`Activation failed: token expired for device ${device.deviceCode}`);
      throw new UnauthorizedException({
        success: false,
        error: 'Provisioning token has expired',
        errorCode: ActivationErrorCode.TOKEN_EXPIRED,
      });
    }

    // Generate MQTT credentials
    const { password: mqttPassword, hash: mqttPasswordHash } = this.generateMqttCredentials();

    // Wrap in transaction to prevent partial activation
    return await this.deviceRepository.manager.transaction(async (transactionalManager) => {
      // Update device
      device.tokenUsedAt = new Date();
      device.fingerprint = fingerprint;
      device.agentVersion = agentVersion;
      device.mqttPasswordHash = mqttPasswordHash;
      device.lifecycleState = DeviceLifecycleState.PROVISIONING;
      device.isOnline = false; // Will be set to true when MQTT heartbeat arrives

      // Clear the token from database (single-use)
      // Use null (not undefined) so TypeORM sends SET provisioning_token = NULL
      (device as any).provisioningToken = null;

      await transactionalManager.save(device);

      // Add MQTT credentials to password file (for Mosquitto auth)
      const mqttClientId = device.mqttClientId ?? '';
      const mqttResult = await this.mqttAuthService.addDeviceCredentials(mqttClientId, mqttPasswordHash);
      if (!mqttResult) {
        throw new Error('Failed to write MQTT credentials');
      }

      this.logger.log(`Device ${device.deviceCode} activated successfully`);

      // Return snake_case response (v1.1 spec)
      const config = await this.installerScriptService.getProvisioningConfig();
      return {
        success: true,
        mqtt_broker: config.mqttBroker,
        mqtt_port: config.mqttPort,
        mqtt_username: mqttClientId,
        mqtt_password: mqttPassword,
        tenant_id: device.tenantId,
        device_code: device.deviceCode,
        config: device.config,
      };
    });
  }

  /**
   * Generate MQTT credentials for a device
   * Uses MqttAuthService for consistent password hashing
   */
  generateMqttCredentials(): { password: string; hash: string } {
    return this.mqttAuthService.generateCredentials();
  }

  /**
   * Build provisioning response.
   * The plaintext token is returned exactly once so the admin can store it
   * (similar to an API key). The token is also required to download the
   * installer script, preventing unauthenticated script retrieval.
   */
  private async buildProvisioningResponse(
    device: EdgeDevice,
    token: string,
  ): Promise<ProvisionedDeviceResponse> {
    return {
      deviceId: device.id,
      deviceCode: device.deviceCode,
      installerUrl: await this.installerScriptService.buildInstallerUrl(device.deviceCode, token),
      installerCommand: await this.installerScriptService.buildInstallerCommand(device.deviceCode, token),
      tokenExpiresAt: device.tokenExpiresAt ?? new Date(),
      status: device.lifecycleState,
      provisioningToken: token,
    };
  }

  /**
   * Get device by code (for installer endpoint)
   */
  async getDeviceByCode(deviceCode: string): Promise<EdgeDevice | null> {
    return this.deviceRepository.findOne({
      where: { deviceCode },
    });
  }

  /**
   * Check if device is ready for activation
   */
  async isDeviceReadyForActivation(deviceCode: string): Promise<{
    ready: boolean;
    reason?: string;
    errorCode?: ActivationErrorCode;
  }> {
    const device = await this.getDeviceByCode(deviceCode);

    if (!device) {
      return { ready: false, reason: 'Device not found', errorCode: ActivationErrorCode.DEVICE_NOT_FOUND };
    }

    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      return { ready: false, reason: 'Device decommissioned', errorCode: ActivationErrorCode.DEVICE_DECOMMISSIONED };
    }

    if (device.tokenUsedAt) {
      return { ready: false, reason: 'Already activated', errorCode: ActivationErrorCode.TOKEN_ALREADY_USED };
    }

    if (!device.provisioningToken) {
      return { ready: false, reason: 'No token', errorCode: ActivationErrorCode.INVALID_TOKEN };
    }

    if (device.tokenExpiresAt && device.tokenExpiresAt < new Date()) {
      return { ready: false, reason: 'Token expired', errorCode: ActivationErrorCode.TOKEN_EXPIRED };
    }

    return { ready: true };
  }

  /**
   * Reset a previously activated device for re-provisioning.
   *
   * Use case: device was activated but lost its config (SD card failure,
   * re-installation, config save failure). Generates a new token so the
   * installer flow can run again.
   *
   * Only TENANT_ADMIN / MODULE_MANAGER should call this (enforced by resolver).
   */
  async resetForReprovisioning(
    deviceId: string,
    tenantId: string,
  ): Promise<RegenerateTokenResponse> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      throw new BadRequestException('Cannot re-provision a decommissioned device');
    }

    // Generate fresh provisioning credentials
    const provisioningToken = this.generateProvisioningToken();
    const tokenExpiresAt = new Date(Date.now() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000);

    // Reset activation state
    await this.deviceRepository.update(device.id, {
      provisioningToken,
      tokenExpiresAt,
      tokenUsedAt: undefined as any, // TypeORM: sends SET token_used_at = NULL
      lifecycleState: DeviceLifecycleState.REGISTERED,
      mqttPasswordHash: undefined as any,
      fingerprint: undefined as any,
      agentVersion: undefined as any,
      isOnline: false,
    });

    // Revoke old MQTT credentials
    if (device.mqttClientId) {
      await this.mqttAuthService.removeDeviceCredentials(device.mqttClientId);
    }

    this.logger.log(`Device ${device.deviceCode} reset for re-provisioning by tenant ${tenantId}`);

    return {
      deviceId: device.id,
      deviceCode: device.deviceCode,
      installerUrl: await this.installerScriptService.buildInstallerUrl(device.deviceCode, provisioningToken),
      installerCommand: await this.installerScriptService.buildInstallerCommand(device.deviceCode, provisioningToken),
      tokenExpiresAt,
    };
  }

  // ============================================
  // Tenant-Level Provisioning (v2.0) - Delegated
  // ============================================

  /**
   * Create a tenant-level provisioning key
   * Delegates to TenantKeyService
   */
  async createTenantKey(
    tenantId: string,
    input: CreateTenantKeyInput,
    createdBy: string,
  ): Promise<TenantKeyResponse> {
    return this.tenantKeyService.createTenantKey(tenantId, input, createdBy);
  }

  /**
   * Revoke a tenant provisioning key
   * Delegates to TenantKeyService
   */
  async revokeTenantKey(keyId: string, tenantId: string): Promise<boolean> {
    return this.tenantKeyService.revokeTenantKey(keyId, tenantId);
  }

  /**
   * List all provisioning keys for a tenant
   * Delegates to TenantKeyService
   */
  async listTenantKeys(tenantId: string): Promise<TenantProvisioningKey[]> {
    return this.tenantKeyService.listTenantKeys(tenantId);
  }

  /**
   * Generate tenant-level installer script
   */
  async generateTenantInstallerScript(tenantToken: string): Promise<string> {
    const key = await this.tenantKeyService.validateAndGetKey(tenantToken);

    const config = await this.installerScriptService.getProvisioningConfig();

    const variables: TenantInstallerScriptVariables = {
      tenantToken: key.keyToken,
      apiUrl: config.apiBaseUrl,
      agentVersion: config.agentVersion,
      mqttPort: config.mqttPort,
    };

    return this.installerScriptService.renderTenantInstallerScript(variables, config);
  }

  /**
   * Self-register a device using a tenant provisioning key
   * Called by the edge agent after installation via tenant installer
   */
  async selfRegisterDevice(request: SelfRegisterRequest): Promise<SelfRegisterResponse> {
    // Validate the tenant key (throws if invalid/revoked/expired/at capacity)
    const key = await this.tenantKeyService.validateAndGetKey(request.tenant_token);

    // Note: maxDevices check is handled atomically below to prevent TOCTOU race

    // Fingerprint duplicate check (with power-loss recovery - Fix 5)
    if (request.fingerprint.machineId) {
      const existing = await this.deviceRepository
        .createQueryBuilder('d')
        .where('d.tenant_id = :tenantId', { tenantId: key.tenantId })
        .andWhere("d.fingerprint->>'machineId' = :machineId", {
          machineId: request.fingerprint.machineId,
        })
        .getOne();

      if (existing) {
        // If device was registered but never connected, return existing credentials for recovery
        if (!existing.isOnline && !existing.lastSeenAt) {
          // Only allow recovery within 1 hour of creation to limit attack window
          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
          if (existing.createdAt && existing.createdAt < oneHourAgo) {
            throw new ConflictException(
              `Device ${existing.deviceCode} registration has expired. Contact administrator to re-provision.`,
            );
          }
          this.logger.log(`Returning existing registration for device ${existing.deviceCode} (power-loss recovery)`);
          const config = await this.installerScriptService.getProvisioningConfig();
          // Regenerate MQTT credentials for the recovery
          const { password: mqttPassword, hash: mqttPasswordHash } = this.generateMqttCredentials();
          existing.mqttPasswordHash = mqttPasswordHash;
          await this.deviceRepository.save(existing);
          const mqttResult = await this.mqttAuthService.addDeviceCredentials(existing.mqttClientId ?? '', mqttPasswordHash);
          if (!mqttResult) {
            throw new Error('Failed to write MQTT credentials');
          }

          return {
            success: true,
            device_id: existing.id,
            device_code: existing.deviceCode,
            mqtt_broker: config.mqttBroker,
            mqtt_port: config.mqttPort,
            mqtt_username: existing.mqttClientId ?? '',
            mqtt_password: mqttPassword,
            tenant_id: existing.tenantId,
          };
        }
        throw new ConflictException(
          `Device with this machine ID is already registered as ${existing.deviceCode}`,
        );
      }
    }

    // Generate device code and MQTT credentials
    const deviceCode = this.generateDeviceCode();
    const mqttClientId = `edge-${key.tenantId.substring(0, 8)}-${deviceCode}`.toLowerCase();
    const { password: mqttPassword, hash: mqttPasswordHash } = this.generateMqttCredentials();

    // Determine lifecycle state based on autoApprove
    const lifecycleState = key.autoApprove
      ? DeviceLifecycleState.ACTIVE
      : DeviceLifecycleState.PENDING_APPROVAL;

    // Wrap in transaction: atomic maxDevices increment + device creation
    // If device creation fails, the usedCount rollback happens automatically
    const saved = await this.deviceRepository.manager.transaction(async (transactionalManager) => {
      // Atomically check and increment used count BEFORE device creation (prevents TOCTOU race + orphans)
      await this.tenantKeyService.incrementUsedCount(key.id, key.maxDevices ?? null, transactionalManager);

      // Create the device record AFTER the maxDevices check
      const device = this.deviceRepository.create({
        tenantId: key.tenantId,
        deviceCode,
        deviceName: request.fingerprint.hostname || deviceCode,
        deviceModel: DeviceModel.CUSTOM,
        siteId: key.defaultSiteId,
        lifecycleState,
        mqttClientId,
        mqttPasswordHash,
        fingerprint: request.fingerprint,
        agentVersion: request.agent_version,
        isOnline: false,
        securityLevel: 2,
      });

      const saved = await transactionalManager.save(device);

      // MQTT credentials INSIDE transaction so rollback on failure
      const mqttResult = await this.mqttAuthService.addDeviceCredentials(mqttClientId, mqttPasswordHash);
      if (!mqttResult) {
        throw new Error('Failed to write MQTT credentials');
      }

      return saved;
    });

    // Log the event (non-critical - must not fail the registration)
    try {
      await this.deviceEventService.logDeviceEvent(
        key.tenantId,
        saved.id,
        DeviceEventType.SELF_REGISTERED,
        DeviceEventSeverity.INFO,
        `Device ${deviceCode} self-registered via tenant key "${key.name || key.id}"`,
        {
          keyId: key.id,
          keyName: key.name,
          autoApprove: key.autoApprove,
          agentVersion: request.agent_version,
        },
      );
    } catch (e) {
      this.logger.error('Failed to log device event', e);
    }

    this.logger.log(
      `Device ${deviceCode} self-registered for tenant ${key.tenantId} (state: ${lifecycleState})`,
    );

    const config = await this.installerScriptService.getProvisioningConfig();
    return {
      success: true,
      device_id: saved.id,
      device_code: saved.deviceCode,
      mqtt_broker: config.mqttBroker,
      mqtt_port: config.mqttPort,
      mqtt_username: mqttClientId,
      mqtt_password: mqttPassword,
      tenant_id: key.tenantId,
    };
  }

  // ============================================
  // Event Logging - Delegated
  // ============================================

  /**
   * Log a device event
   * Delegates to DeviceEventService
   */
  async logDeviceEvent(
    tenantId: string,
    deviceId: string | undefined,
    eventType: DeviceEventType,
    severity: DeviceEventSeverity,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<import('./entities/device-event.entity').DeviceEvent> {
    return this.deviceEventService.logDeviceEvent(tenantId, deviceId, eventType, severity, message, metadata);
  }

  /**
   * Get device events with pagination
   * Delegates to DeviceEventService
   */
  async getDeviceEvents(
    tenantId: string,
    deviceId?: string,
    eventType?: string,
    page = 1,
    limit = 20,
  ): Promise<{ items: import('./entities/device-event.entity').DeviceEvent[]; total: number }> {
    return this.deviceEventService.getDeviceEvents(tenantId, deviceId, eventType, page, limit);
  }
}
