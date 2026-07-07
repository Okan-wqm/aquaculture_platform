import * as crypto from 'crypto';
import {
  getTenantSchemaName,
  runInTenantRead,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';

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
import { DataSource, Repository } from 'typeorm';

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
  isTerminalLifecycleState,
} from './entities/edge-device.entity';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { DeviceEventType, DeviceEventSeverity } from './entities/device-event.entity';
import { MqttAuthService } from './mqtt-auth.service';
import { InstallerScriptService } from './installer-script.service';
import { TenantKeyService } from './tenant-key.service';
import { DeviceEventService } from './device-event.service';
import { DeviceDirectoryService } from './device-directory.service';

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
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly mqttAuthService: MqttAuthService,
    private readonly installerScriptService: InstallerScriptService,
    private readonly tenantKeyService: TenantKeyService,
    private readonly deviceEventService: DeviceEventService,
    private readonly deviceDirectory: DeviceDirectoryService,
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
   * SENSOR-MEDIUM-001: hash a provisioning token for at-rest storage.
   *
   * The plaintext token is a 256-bit crypto-random value, so a plain SHA-256
   * (no salt/stretching needed for high-entropy secrets) is sufficient to make
   * a database leak non-replayable: an attacker who reads `provisioning_token`
   * cannot recover the token an agent must present to activate. SHA-256 hex is
   * exactly 64 chars, so it fits the existing `varchar(64)` column with no
   * schema change. The plaintext is returned to the operator exactly once at
   * creation/regeneration and never persisted in clear.
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
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
      provisioningToken: this.hashToken(provisioningToken),
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

    // SENSOR-MEDIUM-004: publish the O(1) directory route for public lookups.
    await this.deviceDirectory.upsert({
      deviceId: saved.id,
      deviceCode: saved.deviceCode,
      mqttClientId: saved.mqttClientId ?? null,
      tenantId,
    });

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
      provisioningToken: this.hashToken(provisioningToken),
      tokenExpiresAt,
    });
    // Keep the in-memory entity consistent with what is persisted (the hash);
    // the plaintext is surfaced only through the installer URL/command below.
    device.provisioningToken = this.hashToken(provisioningToken);
    device.tokenExpiresAt = tokenExpiresAt;
    const saved = device;
    this.logger.log(`Regenerated token for device ${device.deviceCode}`);

    return {
      deviceId: saved.id,
      deviceCode: saved.deviceCode,
      installerUrl: await this.installerScriptService.buildInstallerUrl(saved.deviceCode),
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
    const device = await this.findDeviceAcrossSchemas('device_code', deviceCode);

    if (!device) {
      throw new NotFoundException(`Device ${deviceCode} not found`);
    }

    // Check if token is valid
    if (!device.provisioningToken) {
      throw new BadRequestException('Device has no provisioning token');
    }

    if (!this.validateProvisioningToken(device.provisioningToken, provisioningToken)) {
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
      // The device bakes this into its config and presents it to activate; the
      // stored value is a SHA-256 hash, so embed the validated plaintext param.
      provisioningToken,
      apiUrl: config.apiBaseUrl,
      agentVersion: config.agentVersion,
      mqttBroker: config.mqttBroker,
      mqttPort: config.mqttPort,
      mqttTlsEnabled: config.mqttTlsEnabled ?? (config.mqttPort === 8883),
    };

    return this.installerScriptService.renderInstallerScript(variables, config);
  }

  /**
   * Generate Suderra OS install manifest for a device.
   *
   * This is the OS-appliance path: the tenant panel gives the target a JSON
   * manifest URL, and the target downloads/verifies the signed Edge artifact.
   */
  async generateSuderraOsInstallManifest(deviceCode: string, provisioningToken: string): Promise<unknown> {
    const device = await this.findDeviceAcrossSchemas('device_code', deviceCode);

    if (!device) {
      throw new NotFoundException(`Device ${deviceCode} not found`);
    }

    if (!device.provisioningToken) {
      throw new BadRequestException('Device has no provisioning token');
    }

    if (!this.validateProvisioningToken(device.provisioningToken, provisioningToken)) {
      throw new UnauthorizedException('Invalid provisioning token');
    }

    if (device.tokenUsedAt) {
      throw new ConflictException('Device has already been activated');
    }

    if (device.tokenExpiresAt && device.tokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Provisioning token has expired');
    }

    const config = await this.installerScriptService.getProvisioningConfig();
    return this.installerScriptService.renderSuderraOsInstallManifest({
      deviceId: device.id,
      deviceCode: device.deviceCode,
      // Stored value is a SHA-256 hash; embed the validated plaintext param so
      // the OS appliance can present it back to activate.
      provisioningToken,
      apiUrl: config.apiBaseUrl,
      agentVersion: config.agentVersion,
      mqttBroker: config.mqttBroker,
      mqttPort: config.mqttPort,
      mqttTlsEnabled: config.mqttTlsEnabled ?? (config.mqttPort === 8883),
    });
  }

  /**
   * Activate a device (called by agent)
   */
  async activateDevice(
    request: DeviceActivationRequest,
  ): Promise<DeviceActivationResponse> {
    const { deviceId, token, fingerprint, agentVersion } = request;

    // Find device across all tenant schemas (public endpoint, no tenant context)
    const device = await this.findDeviceAcrossSchemas('id', deviceId);

    if (!device) {
      this.logger.warn(`Activation failed: device ${deviceId} not found`);
      throw new NotFoundException({
        success: false,
        error: 'Device not found',
        errorCode: ActivationErrorCode.DEVICE_NOT_FOUND,
      });
    }

    // Check if device is in a terminal state (SENSOR-MEDIUM-008: REVOKED is
    // terminal too — a revoked device must not re-activate).
    if (isTerminalLifecycleState(device.lifecycleState)) {
      throw new BadRequestException({
        success: false,
        error: `Device is in a terminal state (${device.lifecycleState})`,
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

    // Validate token via single source of truth (SENSOR-CRITICAL-001)
    if (!this.validateProvisioningToken(device.provisioningToken, token)) {
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
    // Set search_path to the device's tenant schema so TypeORM writes to the correct schema
    return await this.dataSource.transaction(async (transactionalManager) => {
      const tenantSchema = this.getTenantSchemaFromId(device.tenantId);
      await transactionalManager.query(`SET LOCAL search_path TO "${tenantSchema}", sensor, public`);

      // Update device
      device.tokenUsedAt = new Date();
      device.fingerprint = fingerprint;
      device.agentVersion = agentVersion;
      device.mqttPasswordHash = mqttPasswordHash;
      device.lifecycleState = DeviceLifecycleState.ACTIVE;
      device.isOnline = false; // Will be set to true when MQTT heartbeat arrives

      // Clear the token from database (single-use)
      // Use null (not undefined) so TypeORM sends SET provisioning_token = NULL
      device.provisioningToken = null;

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
        mqtt_tls_enabled: config.mqttPort === 8883,
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
      installerUrl: await this.installerScriptService.buildInstallerUrl(device.deviceCode),
      installerCommand: await this.installerScriptService.buildInstallerCommand(device.deviceCode, token),
      tokenExpiresAt: device.tokenExpiresAt ?? new Date(),
      status: device.lifecycleState,
      provisioningToken: token,
    };
  }

  /**
   * Get device by code (for installer endpoint).
   * Searches across all tenant schemas because public provisioning
   * endpoints have no tenant context (search_path defaults to sensor,public).
   */
  async getDeviceByCode(deviceCode: string): Promise<EdgeDevice | null> {
    return this.findDeviceAcrossSchemas('device_code', deviceCode);
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

    // SENSOR-MEDIUM-008: REVOKED is terminal — re-provisioning would silently
    // un-revoke the device.
    if (isTerminalLifecycleState(device.lifecycleState)) {
      throw new BadRequestException(
        `Cannot re-provision a device in a terminal state (${device.lifecycleState})`,
      );
    }

    // Generate fresh provisioning credentials
    const provisioningToken = this.generateProvisioningToken();
    const tokenExpiresAt = new Date(Date.now() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000);

    // Reset activation state
    await this.deviceRepository.update(device.id, {
      provisioningToken: this.hashToken(provisioningToken),
      tokenExpiresAt,
      tokenUsedAt: null, // TypeORM: sends SET token_used_at = NULL
      lifecycleState: DeviceLifecycleState.REGISTERED,
      mqttPasswordHash: null,
      fingerprint: null,
      agentVersion: null,
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
      installerUrl: await this.installerScriptService.buildInstallerUrl(device.deviceCode),
      installerCommand: await this.installerScriptService.buildInstallerCommand(device.deviceCode, provisioningToken),
      tokenExpiresAt,
    };
  }

  /**
   * Generate uninstall script for a device.
   * No token required — the script only performs local cleanup.
   */
  async generateUninstallScript(deviceCode: string): Promise<string> {
    return this.installerScriptService.renderUninstallScript(deviceCode);
  }

  /**
   * Generate update script for a device.
   * No token required — the script only replaces the binary, config is preserved.
   */
  async generateUpdateScript(deviceCode: string): Promise<string> {
    return this.installerScriptService.renderUpdateScript(deviceCode);
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
      // key.keyToken is now the SHA-256 hash at rest; the installer must carry
      // the validated plaintext the agent presents at self-register.
      tenantToken,
      apiUrl: config.apiBaseUrl,
      agentVersion: config.agentVersion,
      mqttPort: config.mqttPort,
      mqttTlsEnabled: config.mqttTlsEnabled ?? (config.mqttPort === 8883),
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
      const existing = await runInTenantRead(this.dataSource, 'sensor', key.tenantId, async (qr) =>
        tenantManagerRepo(qr.manager, EdgeDevice, key.tenantId)
          .createQueryBuilder('d')
          .andWhere("d.fingerprint->>'machineId' = :machineId", {
            machineId: request.fingerprint.machineId,
          })
          .getOne(),
      );

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
          await this.dataSource.transaction(async (txManager) => {
            const recoverySchema = this.getTenantSchemaFromId(existing.tenantId);
            await txManager.query(`SET LOCAL search_path TO "${recoverySchema}", sensor, public`);
            await txManager.save(existing);
          });
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
    const saved = await this.dataSource.transaction(async (transactionalManager) => {
      const tenantSchema = this.getTenantSchemaFromId(key.tenantId);
      await transactionalManager.query(`SET LOCAL search_path TO "${tenantSchema}", sensor, public`);

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

      // SENSOR-MEDIUM-004: publish the directory route in the same transaction
      // so a committed device is always resolvable in O(1).
      await this.deviceDirectory.upsert(
        {
          deviceId: saved.id,
          deviceCode: saved.deviceCode,
          mqttClientId: saved.mqttClientId ?? null,
          tenantId: key.tenantId,
        },
        transactionalManager,
      );

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
      mqtt_tls_enabled: config.mqttPort === 8883,
    };
  }

  // ============================================
  // Tenant Schema Helpers
  // ============================================

  /**
   * Delegate to the canonical backend-common implementation.
   * Duplicate removed — single source of truth in getTenantSchemaName().
   */
  private getTenantSchemaFromId(tenantId: string): string {
    return getTenantSchemaName(tenantId);
  }

  // ============================================
  // Cross-Schema Device Lookup (for public endpoints)
  // ============================================

  /**
   * Find a device across all tenant schemas.
   *
   * Public provisioning endpoints (install, activate) have no tenant context,
   * so search_path defaults to "sensor, public". But devices are stored in
   * tenant-specific schemas (tenant_*). This method dynamically builds a
   * UNION ALL query across all tenant schemas to find the device.
   */
  private async findDeviceAcrossSchemas(
    column: 'device_code' | 'id',
    value: string,
  ): Promise<EdgeDevice | null> {
    // SENSOR-MEDIUM-004: O(1) directory route first — resolve the tenant with a
    // single indexed lookup, then query only that tenant's edge_devices.
    const tenantId = await this.deviceDirectory.lookupTenantId(column, value);
    if (tenantId) {
      const schema = this.getTenantSchemaFromId(tenantId);
      const rows = await this.dataSource.query(
        `SELECT * FROM "${schema}".edge_devices WHERE ${column} = $1 LIMIT 1`,
        [value],
      );
      if (rows && rows.length > 0) {
        return this.mapRowToEdgeDevice(rows[0]);
      }
      // Stale directory entry (device moved/deleted): fall through to the scan.
    }

    const device = await this.scanDeviceAcrossSchemas(column, value);
    if (device) {
      await this.deviceDirectory.backfill({
        deviceId: device.id,
        deviceCode: device.deviceCode,
        mqttClientId: device.mqttClientId ?? null,
        tenantId: device.tenantId,
      });
    }
    return device;
  }

  /**
   * Authoritative fallback: UNION-ALL scan across every tenant schema. Used only
   * when the directory misses (SENSOR-MEDIUM-004).
   */
  private async scanDeviceAcrossSchemas(
    column: 'device_code' | 'id',
    value: string,
  ): Promise<EdgeDevice | null> {
    // 1. Get all tenant schemas
    const schemas: { schema_name: string }[] = await this.dataSource.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'`,
    );

    if (schemas.length === 0) {
      return null;
    }

    // 2. Build UNION ALL query across all tenant schemas
    // Schema names are validated by the regex above (tenant_ + 16 hex chars only)
    const unionParts = schemas.map(
      (s) => `SELECT * FROM "${s.schema_name}".edge_devices WHERE ${column} = $1`,
    );
    const sql = `(${unionParts.join(' UNION ALL ')}) LIMIT 1`;

    const rows = await this.dataSource.query(sql, [value]);

    if (!rows || rows.length === 0) {
      return null;
    }

    // 3. Map raw row to EdgeDevice entity (snake_case → camelCase)
    return this.mapRowToEdgeDevice(rows[0]);
  }

  /**
   * Map a raw database row (snake_case) to an EdgeDevice entity (camelCase).
   * Only maps fields needed for provisioning operations.
   */
  private mapRowToEdgeDevice(row: Record<string, any>): EdgeDevice {
    const device = new EdgeDevice();
    device.id = row['id'];
    device.tenantId = row['tenant_id'];
    device.deviceCode = row['device_code'];
    device.deviceName = row['device_name'];
    device.deviceModel = row['device_model'];
    device.serialNumber = row['serial_number'];
    device.description = row['description'];
    device.siteId = row['site_id'];
    device.lifecycleState = row['lifecycle_state'];
    device.provisioningToken = row['provisioning_token'];
    device.tokenExpiresAt = row['token_expires_at'] ? new Date(row['token_expires_at']) : undefined;
    device.tokenUsedAt = row['token_used_at'] ? new Date(row['token_used_at']) : null;
    device.mqttClientId = row['mqtt_client_id'];
    device.mqttPasswordHash = row['mqtt_password_hash'];
    device.fingerprint = row['fingerprint'];
    device.agentVersion = row['agent_version'];
    device.isOnline = row['is_online'];
    device.lastSeenAt = row['last_seen_at'] ? new Date(row['last_seen_at']) : undefined;
    device.config = row['config'];
    device.securityLevel = row['security_level'];
    device.createdBy = row['created_by'];
    device.createdAt = new Date(row['created_at']);
    device.updatedAt = new Date(row['updated_at']);
    return device;
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
  ): Promise<{ items: import('./entities/device-event.entity').DeviceEvent[]; total: number; page: number; limit: number }> {
    return this.deviceEventService.getDeviceEvents(tenantId, deviceId, eventType, page, limit);
  }

  /**
   * SECURITY: Single source of truth for provisioning token validation.
   *
   * SENSOR-MEDIUM-001: the column now stores `sha256(token)` (hex), not the
   * plaintext. Validation therefore hashes the provided plaintext once and
   * compares it, in constant time, against the stored digest bytes:
   * - Timing side-channel attacks are defeated by crypto.timingSafeEqual.
   * - A database leak of `provisioning_token` is non-replayable (pre-image
   *   resistance) — the raw token an agent must present is never at rest.
   *
   * All code paths that compare provisioning tokens MUST use this method.
   * Direct `===` comparison on tokens is FORBIDDEN (SENSOR-CRITICAL-001).
   *
   * @param storedHash - The SHA-256 hex digest stored on the device (may be null)
   * @param providedToken - The plaintext token provided by the caller
   * @returns true if tokens match, false otherwise
   */
  private validateProvisioningToken(storedHash: string | null | undefined, providedToken: string): boolean {
    if (!storedHash) {
      return false;
    }
    const providedHashBytes = crypto.createHash('sha256').update(providedToken).digest();
    const storedHashBytes = Buffer.from(storedHash, 'hex');
    // A malformed/legacy value that is not a 32-byte SHA-256 digest can never
    // match — length divergence short-circuits before the constant-time compare.
    if (storedHashBytes.length !== providedHashBytes.length) {
      return false;
    }
    return crypto.timingSafeEqual(providedHashBytes, storedHashBytes);
  }
}
