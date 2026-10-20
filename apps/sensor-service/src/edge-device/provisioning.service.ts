import * as crypto from 'crypto';
import {
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
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
  EdgeAgentChannel,
  EdgeDevice,
  DeviceLifecycleState,
  DeviceModel,
  isTerminalLifecycleState,
  provisioningPhaseOf,
  ProvisioningPhase,
} from './entities/edge-device.entity';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { DeviceEventType, DeviceEventSeverity } from './entities/device-event.entity';
import { MqttAuthService } from './mqtt-auth.service';
import { InstallerScriptService } from './installer-script.service';
import { TenantKeyService } from './tenant-key.service';
import { DeviceEventService } from './device-event.service';
import { type DeviceBrokerEndpoint } from './device-broker';
import { DeviceDirectoryService } from './device-directory.service';
import { DeviceLifecycleStatementService } from './device-lifecycle-statement.service';
import { type DeviceBinding, wholeSecond } from './edge-contract';
import { EdgeRootHandoffService } from './edge-root-handoff.service';
import {
  EdgeProvisioningManifestService,
  parseProvisioningRequest,
  ProvisioningRefusal,
} from './edge-provisioning-manifest.service';
import {
  hashProvisioningToken,
  ProvisioningReservationService,
  type ReprovisioningRefusal,
  SUDERRA_OS_TOKEN_MAX_AGE_MS,
} from './provisioning-reservation.service';

/** How long a Suderra OS device stays in MAINTENANCE for re-provisioning (DEC-5.14). */
const REPROVISIONING_WINDOW_MS = 2 * 60 * 60 * 1000;

/** What the operator is told when a Suderra OS re-provisioning cannot open. */
const REPROVISIONING_REFUSALS: Readonly<
  Record<ReprovisioningRefusal, (device: EdgeDevice) => Error>
> = {
  terminal: (device) =>
    new BadRequestException(
      `Cannot re-provision a device in a terminal state (${device.lifecycleState})`,
    ),
  'not-committed': () =>
    new ConflictException('The device changed while re-provisioning was requested; retry'),
  'receipt-not-handed': () =>
    new ConflictException(
      'The device has not confirmed its activation to its OS yet; re-provisioning needs an ACTIVE device',
    ),
  'window-open': () =>
    new ConflictException(
      'A re-provisioning window is already open; use the token issued with it or wait until it ends',
    ),
};

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
    private readonly reservations: ProvisioningReservationService,
    private readonly suderraOsManifests: EdgeProvisioningManifestService,
    private readonly lifecycleStatements: DeviceLifecycleStatementService,
    private readonly rootHandoff: EdgeRootHandoffService,
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
    return hashProvisioningToken(token);
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
    const tokenIssuedAt = new Date();
    const tokenExpiresAt = new Date(
      tokenIssuedAt.getTime() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );

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
      tokenIssuedAt,
      tokenExpiresAt,
      mqttClientId,
      isOnline: false,
      securityLevel: 2,
      createdBy,
    });

    // SENSOR-MEDIUM-004: the device and its O(1) directory route commit
    // together — the unauthenticated lookup paths do not scan tenants, so a
    // device without a route could never be resolved.
    let saved: EdgeDevice;
    try {
      saved = await runInTenantTransaction(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, (qr) =>
        this.deviceDirectory.saveNewDevice(device, qr.manager),
      );
    } catch (error: any) {
      if (error?.code === '23505') {
        // PostgreSQL unique violation
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
  async regenerateToken(deviceId: string, tenantId: string): Promise<RegenerateTokenResponse> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    // Only a device that never committed an activation regenerates: its
    // credential, if any, was issued for an activation nobody completed. A
    // device that committed one — including a Suderra OS device whose
    // re-provisioning token was issued since (token_used_at is that token's)
    // — keeps a live credential and a committed identity; it is
    // re-provisioned instead (resetForReprovisioning), never silently revoked.
    if (device.tokenUsedAt !== null || this.committedBinding(device) !== null) {
      throw new ConflictException(
        'This device has committed an activation; re-provision it instead of regenerating its token',
      );
    }

    // Don't allow regeneration for a terminal device
    if (isTerminalLifecycleState(device.lifecycleState)) {
      throw new BadRequestException(
        'Cannot regenerate token for a decommissioned or revoked device',
      );
    }

    // Generate new token. The previous token, any manifest reservation and
    // any credential issued for an activation that never committed are
    // void with it (ADR-048 DEC-5.7).
    const provisioningToken = this.generateProvisioningToken();
    const tokenIssuedAt = new Date();
    const tokenExpiresAt = new Date(
      tokenIssuedAt.getTime() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );

    const reissued = await this.reservations.reissueToken(device, {
      tokenHash: this.hashToken(provisioningToken),
      tokenIssuedAt,
      tokenExpiresAt,
      lifecycleState: device.lifecycleState,
    });
    if (!reissued) {
      throw new BadRequestException(
        'Cannot regenerate token for a decommissioned or revoked device',
      );
    }
    if (device.mqttClientId && device.credentialsIssuedAt !== null) {
      await this.mqttAuthService.removeDeviceCredentials(device.mqttClientId);
    }
    const saved = device;
    this.logger.log(`Regenerated token for device ${device.deviceCode}`);

    return {
      deviceId: saved.id,
      deviceCode: saved.deviceCode,
      installerUrl: await this.installerScriptService.buildInstallerUrl(saved.deviceCode),
      installerCommand: await this.installerScriptService.buildInstallerCommand(
        saved.deviceCode,
        provisioningToken,
      ),
      suderraOsProvisioningCommand: this.installerScriptService.buildSuderraOsProvisioningCommand(
        saved.deviceCode,
      ),
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
      broker: config.deviceBroker,
    };

    return this.installerScriptService.renderInstallerScript(variables, config);
  }

  /**
   * The Suderra OS provisioning delivery (ADR-048 DEC-5.5–5.7, delivery.json):
   * the device-bound, signed suderra.edge-provisioning.v1 manifest with the
   * release statement, trust-anchors bundle, site config, RBAC manifest and
   * site files it names, issued under a manifest reservation bound to the
   * device binding the request presents.
   *
   * Every refusal is a {@link ProvisioningRefusal}; the controller answers
   * them all identically (DEC-22), so the reason is only logged here.
   */
  async deliverSuderraOsManifest(
    deviceCode: string,
    token: string | undefined,
    query: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const request = parseProvisioningRequest(query);
    if (request === null || token === undefined || !/^[0-9a-f]{64}$/.test(token)) {
      throw new ProvisioningRefusal('request-invalid');
    }
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(deviceCode)) {
      throw new ProvisioningRefusal('request-invalid');
    }
    const device = await this.findDeviceAcrossSchemas('device_code', deviceCode);
    if (!device) throw new ProvisioningRefusal('device-unknown');
    if (!this.validateProvisioningToken(device.provisioningToken, token)) {
      throw new ProvisioningRefusal('token-invalid');
    }
    if (isTerminalLifecycleState(device.lifecycleState)) {
      throw new ProvisioningRefusal('device-terminal');
    }
    const now = new Date();
    const phase = provisioningPhaseOf(device, now);
    if (phase === ProvisioningPhase.COMMITTED) throw new ProvisioningRefusal('token-spent');
    if (
      (device.tokenExpiresAt && device.tokenExpiresAt <= now) ||
      device.tokenIssuedAt === null ||
      device.tokenIssuedAt.getTime() <= now.getTime() - SUDERRA_OS_TOKEN_MAX_AGE_MS
    ) {
      // DEC-5.12: a Suderra OS manifest needs a token hours old at most.
      throw new ProvisioningRefusal('token-expired');
    }
    if (
      device.deviceBindingSha256 !== null &&
      (device.deviceBindingSha256 !== request.binding.digest.sha256 ||
        device.deviceBindingMethod !== request.binding.method)
    ) {
      throw new ProvisioningRefusal('binding-differs-from-device');
    }

    const release = await this.suderraOsManifests.preflight(request, device);
    const body = await this.reservations.reserve(
      device,
      token,
      request.binding,
      this.suderraOsManifests.reservationTtlMs,
      now,
      (reservation) => {
        const issued = this.suderraOsManifests.issue(
          { ...reservation, provisioningToken: token },
          release,
          request.nonce,
        );
        return { result: issued.body, manifestDigest: issued.manifest.digest };
      },
    );
    if (body === null) throw new ProvisioningRefusal('binding-reserved-elsewhere');
    this.logger.log({
      event: 'suderra_os_manifest_issued',
      deviceId: device.id,
      tenantId: device.tenantId,
      board: request.boardProfile,
      release: release.version,
    });
    return body;
  }

  /**
   * Activate a device (called by agent).
   *
   * ADR-048 DEC-5.7: activation ISSUES the broker credential and leaves the
   * single-use token unspent (ACTIVATION_PENDING); it may be repeated, each
   * time replacing the credential. The token is spent only when the device's
   * own credential authenticates its first broker CONNECT
   * (MqttAuthService → ProvisioningReservationService.commitFirstSession), so
   * a device that lost the response — or could not persist it — activates
   * again instead of being locked out. The guard is one conditional update:
   * two racing activations each get a credential, and the last one written
   * is the one that can commit.
   */
  async activateDevice(request: DeviceActivationRequest): Promise<DeviceActivationResponse> {
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
    const { password: mqttPassword, hash: mqttPasswordHash } = await this.generateMqttCredentials();

    const issued = await this.reservations.issueCredentials(
      device,
      token,
      { fingerprint, agentVersion, mqttPasswordHash },
      new Date(),
    );
    if (!issued) {
      // The row changed under us (token spent or regenerated, reservation
      // lapsed, device revoked) or a Suderra OS device has no manifest
      // reservation to activate under.
      this.logger.warn(`Activation refused by the provisioning state of ${device.deviceCode}`);
      throw new ConflictException({
        success: false,
        error: 'Device is not awaiting activation',
        errorCode: ActivationErrorCode.INVALID_TOKEN,
      });
    }

    // Add MQTT credentials to password file (for Mosquitto file-auth mode)
    const mqttClientId = device.mqttClientId ?? '';
    const mqttResult = await this.mqttAuthService.addDeviceCredentials(
      mqttClientId,
      mqttPasswordHash,
    );
    if (!mqttResult) {
      throw new Error('Failed to write MQTT credentials');
    }

    this.logger.log(`Device ${device.deviceCode} issued activation credentials (pending commit)`);

    // Return snake_case response (v1.1 spec)
    const broker = await this.brokerEndpointFor(device.agentChannel);
    return {
      success: true,
      mqtt_broker: broker.host,
      mqtt_port: broker.port,
      mqtt_username: mqttClientId,
      mqtt_password: mqttPassword,
      tenant_id: device.tenantId,
      device_code: device.deviceCode,
      mqtt_tls_enabled: broker.tls,
      config: device.config,
    };
  }

  /**
   * The broker an activated device is told about. A Suderra OS agent takes
   * its broker only from the signed site config (DEC-10.1) — the same
   * 8883 TLS endpoint named here; a generic agent without one configured
   * uses this response's.
   */
  private async brokerEndpointFor(channel: EdgeAgentChannel): Promise<DeviceBrokerEndpoint> {
    if (channel === EdgeAgentChannel.SUDERRA_OS) {
      return this.suderraOsManifests.deviceBroker();
    }
    return (await this.installerScriptService.getProvisioningConfig()).deviceBroker;
  }

  /**
   * Generate MQTT credentials for a device
   * Uses MqttAuthService for consistent password hashing
   */
  generateMqttCredentials(): Promise<{ password: string; hash: string }> {
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
      installerCommand: await this.installerScriptService.buildInstallerCommand(
        device.deviceCode,
        token,
      ),
      suderraOsProvisioningCommand: this.installerScriptService.buildSuderraOsProvisioningCommand(
        device.deviceCode,
      ),
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
      return {
        ready: false,
        reason: 'Device not found',
        errorCode: ActivationErrorCode.DEVICE_NOT_FOUND,
      };
    }

    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      return {
        ready: false,
        reason: 'Device decommissioned',
        errorCode: ActivationErrorCode.DEVICE_DECOMMISSIONED,
      };
    }

    if (device.tokenUsedAt) {
      return {
        ready: false,
        reason: 'Already activated',
        errorCode: ActivationErrorCode.TOKEN_ALREADY_USED,
      };
    }

    if (!device.provisioningToken) {
      return { ready: false, reason: 'No token', errorCode: ActivationErrorCode.INVALID_TOKEN };
    }

    if (device.tokenExpiresAt && device.tokenExpiresAt < new Date()) {
      return {
        ready: false,
        reason: 'Token expired',
        errorCode: ActivationErrorCode.TOKEN_EXPIRED,
      };
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

    // A Suderra OS device whose root recorded its activation (the receipt
    // was handed over) re-provisions in place, under a signed lifecycle
    // statement, keeping its identity and credential (DEC-5.14).
    const binding = this.committedBinding(device);
    if (
      device.agentChannel === EdgeAgentChannel.SUDERRA_OS &&
      binding !== null &&
      device.activationReceiptHandedAt !== null
    ) {
      return this.beginSuderraOsReprovisioning(device, binding, provisioningToken);
    }

    // Everything else re-installs from scratch: a generic-Linux device, or a
    // Suderra OS device root never confirmed (it is still PROVISIONING, its
    // surface opens at the next boot window). A fresh token in TOKEN_ISSUED,
    // the broker credential revoked, every reservation and pending
    // activation void; the committed binding stays — the same hardware.
    const tokenIssuedAt = new Date();
    const tokenExpiresAt = new Date(
      tokenIssuedAt.getTime() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );
    const reissued = await this.reservations.reissueToken(device, {
      tokenHash: this.hashToken(provisioningToken),
      tokenIssuedAt,
      tokenExpiresAt,
      lifecycleState: DeviceLifecycleState.REGISTERED,
    });
    if (!reissued) {
      throw new BadRequestException(
        `Cannot re-provision a device in a terminal state (${device.lifecycleState})`,
      );
    }

    // Revoke old MQTT credentials
    if (device.mqttClientId) {
      await this.mqttAuthService.removeDeviceCredentials(device.mqttClientId);
    }

    this.logger.log(`Device ${device.deviceCode} reset for re-provisioning by tenant ${tenantId}`);

    return {
      deviceId: device.id,
      deviceCode: device.deviceCode,
      installerUrl: await this.installerScriptService.buildInstallerUrl(device.deviceCode),
      installerCommand: await this.installerScriptService.buildInstallerCommand(
        device.deviceCode,
        provisioningToken,
      ),
      suderraOsProvisioningCommand: this.installerScriptService.buildSuderraOsProvisioningCommand(
        device.deviceCode,
      ),
      tokenExpiresAt,
    };
  }

  /** The hardware identity the device committed at its first activation, if any. */
  private committedBinding(device: EdgeDevice): DeviceBinding | null {
    return device.deviceBindingMethod === null || device.deviceBindingSha256 === null
      ? null
      : { method: device.deviceBindingMethod, digest: { sha256: device.deviceBindingSha256 } };
  }

  /**
   * Re-provisioning a Suderra OS device (ADR-048 DEC-5.14, DEC-12): a
   * device-lifecycle statement — signed by the separate device-lifecycle key,
   * bound to the device's committed hardware identity — that moves the device
   * to MAINTENANCE for a bounded window so its provisioning surface opens for
   * the technician, and a fresh token that expires with that window. Both
   * are stored in one transaction before anything is published; the
   * statement is then delivered (now if the device is online, and on its
   * heartbeats until the agent reports it handed to root), so neither a
   * broker failure nor an offline device loses it. The committed activation
   * and the running agent's credential stay until the new commit replaces
   * them; a window that lapses unused returns the row to ACTIVE.
   */
  private async beginSuderraOsReprovisioning(
    device: EdgeDevice,
    binding: DeviceBinding,
    provisioningToken: string,
  ): Promise<RegenerateTokenResponse> {
    const now = wholeSecond(new Date());
    const window = {
      notBefore: new Date(now.getTime() - 5 * 60 * 1000),
      expiresAt: new Date(now.getTime() + REPROVISIONING_WINDOW_MS),
    };
    const started = await this.reservations.beginReprovisioning(
      device,
      binding,
      this.hashToken(provisioningToken),
      window,
      now,
      (updateSeq) =>
        this.lifecycleStatements.enterMaintenanceForReprovisioning({
          tenantId: device.tenantId,
          deviceId: device.id,
          binding,
          updateSeq,
          window,
        }),
    );
    if (typeof started === 'string') {
      throw REPROVISIONING_REFUSALS[started](device);
    }
    await this.rootHandoff.deliverLifecycleRequest(device, now);
    this.logger.log({
      event: 'suderra_os_reprovisioning_requested',
      deviceId: device.id,
      lifecycleSeq: started.lifecycleSeq,
    });
    const tokenExpiresAt = started.windowEndsAt;
    return {
      deviceId: device.id,
      deviceCode: device.deviceCode,
      installerUrl: await this.installerScriptService.buildInstallerUrl(device.deviceCode),
      installerCommand: await this.installerScriptService.buildInstallerCommand(
        device.deviceCode,
        provisioningToken,
      ),
      suderraOsProvisioningCommand: this.installerScriptService.buildSuderraOsProvisioningCommand(
        device.deviceCode,
      ),
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
      broker: config.deviceBroker,
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
      const existing = await runInTenantRead(
        this.dataSource,
        SENSOR_SOURCE_SCHEMA,
        key.tenantId,
        async (qr) =>
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
          this.logger.log(
            `Returning existing registration for device ${existing.deviceCode} (power-loss recovery)`,
          );
          const broker = await this.brokerEndpointFor(EdgeAgentChannel.GENERIC_LINUX);
          // Regenerate MQTT credentials for the recovery
          const { password: mqttPassword, hash: mqttPasswordHash } =
            await this.generateMqttCredentials();
          existing.mqttPasswordHash = mqttPasswordHash;
          await runInTenantTransaction(
            this.dataSource,
            SENSOR_SOURCE_SCHEMA,
            existing.tenantId,
            (qr) => qr.manager.save(existing),
          );
          const mqttResult = await this.mqttAuthService.addDeviceCredentials(
            existing.mqttClientId ?? '',
            mqttPasswordHash,
          );
          if (!mqttResult) {
            throw new Error('Failed to write MQTT credentials');
          }

          return {
            success: true,
            device_id: existing.id,
            device_code: existing.deviceCode,
            mqtt_broker: broker.host,
            mqtt_port: broker.port,
            mqtt_username: existing.mqttClientId ?? '',
            mqtt_password: mqttPassword,
            tenant_id: existing.tenantId,
            mqtt_tls_enabled: broker.tls,
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
    const { password: mqttPassword, hash: mqttPasswordHash } = await this.generateMqttCredentials();

    // Determine lifecycle state based on autoApprove. A PENDING_APPROVAL device
    // still receives its MQTT password here: the edge agent's self-register
    // contract (sens-api-gateway/src/provisioning.rs SelfRegisterResponse,
    // `mqtt_password: String`) persists it once and has no later credential
    // fetch. The broker refuses it until approval — mayHoldBrokerSession gates
    // CONNECT and every ACL check — and the agent's reconnect loop succeeds
    // once an operator approves.
    const lifecycleState = key.autoApprove
      ? DeviceLifecycleState.ACTIVE
      : DeviceLifecycleState.PENDING_APPROVAL;

    // Wrap in transaction: atomic maxDevices increment + device creation
    // If device creation fails, the usedCount rollback happens automatically
    // SENSOR-CRITICAL-143: inside the key's tenant boundary — with search_path
    // alone the INSERT failed the FORCE RLS WITH CHECK (tenant GUC unset).
    const saved = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      key.tenantId,
      async (qr) => {
        const transactionalManager = qr.manager;

        // Atomically check and increment used count BEFORE device creation (prevents TOCTOU race + orphans)
        await this.tenantKeyService.incrementUsedCount(key.id, transactionalManager);

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

        // SENSOR-MEDIUM-004: the device and its directory route commit together.
        const saved = await this.deviceDirectory.saveNewDevice(device, transactionalManager);

        // MQTT credentials INSIDE transaction so rollback on failure
        const mqttResult = await this.mqttAuthService.addDeviceCredentials(
          mqttClientId,
          mqttPasswordHash,
        );
        if (!mqttResult) {
          throw new Error('Failed to write MQTT credentials');
        }

        return saved;
      },
    );

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

    // Self-registration is the generic-Linux installer's path.
    const broker = await this.brokerEndpointFor(EdgeAgentChannel.GENERIC_LINUX);
    return {
      success: true,
      device_id: saved.id,
      device_code: saved.deviceCode,
      mqtt_broker: broker.host,
      mqtt_port: broker.port,
      mqtt_username: mqttClientId,
      mqtt_password: mqttPassword,
      tenant_id: key.tenantId,
      mqtt_tls_enabled: broker.tls,
    };
  }

  // ============================================
  // Cross-Schema Device Lookup (for public endpoints)
  // ============================================

  /**
   * Find a device by a public identifier with no tenant context (install /
   * activate endpoints). SENSOR-CRITICAL-143: the directory + per-tenant
   * boundary lookup lives once in DeviceDirectoryService.findDevice.
   */
  private findDeviceAcrossSchemas(
    column: 'device_code' | 'id',
    value: string,
  ): Promise<EdgeDevice | null> {
    return this.deviceDirectory.findDevice(column, value);
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
    return this.deviceEventService.logDeviceEvent(
      tenantId,
      deviceId,
      eventType,
      severity,
      message,
      metadata,
    );
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
  ): Promise<{
    items: import('./entities/device-event.entity').DeviceEvent[];
    total: number;
    page: number;
    limit: number;
  }> {
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
  private validateProvisioningToken(
    storedHash: string | null | undefined,
    providedToken: string,
  ): boolean {
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
