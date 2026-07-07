import {
  Tenant,
  CurrentUser,
  Roles,
  Role,
  RequireTenantPermission,
} from '@aquaculture/backend-common/decorators';
import { Logger } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, Int, ID, ResolveField, Parent } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AutomationProgram, ProgramStatus } from '../automation/entities/automation-program.entity';
import { Sensor, SensorStatus } from '../database/entities/sensor.entity';
import { PlcAlarm } from '../plc-control/entities/plc-alarm.entity';

import {
  RegisterEdgeDeviceInput,
  UpdateEdgeDeviceInput,
  AddIoConfigInput,
  UpdateIoConfigInput,
  EdgeDeviceConnection,
  EdgeDeviceStats,
  PingResult,
  PushIoConfigResult,
  SetDigitalOutputInput,
  SetDigitalOutputResult,
  HardwareScanResultType,
  BulkAddIoConfigResult,
  DeviceInstallCommands,
  AddLoRaDeviceInput,
  LoRaDeviceType,
  SendLoRaDownlinkResult,
  SendLoRaDownlinkInput,
  FirmwareVersionInfo,
  BulkFirmwareUpdateResult,
} from './dto/edge-device.dto';
import {
  CreateProvisionedDeviceInput,
  ProvisionedDeviceResponse,
  RegenerateTokenResponse,
  CreateTenantKeyInput,
  TenantKeyResponse,
  DeviceEventConnection,
} from './dto/provisioning.dto';
import { EdgeDeviceService } from './edge-device.service';
import { DeviceIoConfig } from './entities/device-io-config.entity';
import { EdgeDevice, DeviceLifecycleState } from './entities/edge-device.entity';
import { LoRaDevice } from './entities/lora-device.entity';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { ProvisioningService } from './provisioning.service';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

/**
 * Edge Device Resolver
 * GraphQL resolver for industrial edge device management
 */
@Resolver(() => EdgeDevice)
export class EdgeDeviceResolver {
  private readonly logger = new Logger(EdgeDeviceResolver.name);

  constructor(
    private readonly edgeDeviceService: EdgeDeviceService,
    private readonly provisioningService: ProvisioningService,
    @InjectRepository(AutomationProgram)
    private readonly automationProgramRepo: Repository<AutomationProgram>,
    @InjectRepository(Sensor)
    private readonly sensorRepo: Repository<Sensor>,
    @InjectRepository(PlcAlarm)
    private readonly plcAlarmRepo: Repository<PlcAlarm>,
  ) {}

  // ==================== Queries ====================

  /**
   * Get a single edge device by ID
   */
  @Query(() => EdgeDevice, { name: 'edgeDevice', nullable: true })
  async getEdgeDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<EdgeDevice | null> {
    return await this.edgeDeviceService.findById(id, tenantId);
  }

  /**
   * List all edge devices with filtering and pagination
   */
  @Query(() => EdgeDeviceConnection, { name: 'edgeDevices' })
  async listEdgeDevices(
    @Tenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('lifecycleState', { type: () => DeviceLifecycleState, nullable: true })
    lifecycleState?: DeviceLifecycleState,
    @Args('isOnline', { type: () => Boolean, nullable: true }) isOnline?: boolean,
    @Args('search', { type: () => String, nullable: true }) search?: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<EdgeDeviceConnection> {
    return await this.edgeDeviceService.findAll(tenantId, {
      siteId,
      lifecycleState,
      isOnline,
      search,
      page,
      limit,
    });
  }

  /**
   * Get edge device statistics for dashboard
   */
  @Query(() => EdgeDeviceStats, { name: 'edgeDeviceStats' })
  async getEdgeDeviceStats(@Tenant() tenantId: string): Promise<EdgeDeviceStats> {
    return await this.edgeDeviceService.getStats(tenantId);
  }

  /**
   * Get install/uninstall commands for a device
   * Always available in device settings tab
   */
  @Query(() => DeviceInstallCommands, { name: 'deviceInstallCommands' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getDeviceInstallCommands(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<DeviceInstallCommands> {
    return await this.edgeDeviceService.getInstallCommands(deviceId, tenantId);
  }

  // ==================== Mutations ====================

  /**
   * Register a new edge device
   */
  @Mutation(() => EdgeDevice, { name: 'registerEdgeDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async registerEdgeDevice(
    @Args('input') input: RegisterEdgeDeviceInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<EdgeDevice> {
    this.logger.log(`Registering edge device: ${input.deviceCode}`);
    return await this.edgeDeviceService.registerDevice(tenantId, input, user.sub);
  }

  /**
   * Update an edge device
   */
  @Mutation(() => EdgeDevice, { name: 'updateEdgeDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateEdgeDevice(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateEdgeDeviceInput,
    @Tenant() tenantId: string,
  ): Promise<EdgeDevice> {
    return await this.edgeDeviceService.updateDevice(id, tenantId, input);
  }

  /**
   * Approve a registered device (move to ACTIVE state)
   */
  @Mutation(() => EdgeDevice, { name: 'approveEdgeDevice' })
  @Roles(Role.TENANT_ADMIN)
  async approveEdgeDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<EdgeDevice> {
    this.logger.log(`Approving edge device: ${id}`);
    return await this.edgeDeviceService.approveDevice(id, tenantId, user.sub);
  }

  /**
   * Set device maintenance mode
   */
  @Mutation(() => EdgeDevice, { name: 'setDeviceMaintenanceMode' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async setDeviceMaintenanceMode(
    @Args('id', { type: () => ID }) id: string,
    @Args('enabled', { type: () => Boolean }) enabled: boolean,
    @Tenant() tenantId: string,
  ): Promise<EdgeDevice> {
    return await this.edgeDeviceService.setMaintenanceMode(id, tenantId, enabled);
  }

  /**
   * Decommission an edge device
   */
  @Mutation(() => EdgeDevice, { name: 'decommissionEdgeDevice' })
  @Roles(Role.TENANT_ADMIN)
  async decommissionEdgeDevice(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason', { type: () => String }) reason: string,
    @Tenant() tenantId: string,
  ): Promise<EdgeDevice> {
    this.logger.log(`Decommissioning edge device: ${id}, reason: ${reason}`);
    return await this.edgeDeviceService.decommissionDevice(id, tenantId, reason);
  }

  /**
   * Ping a device to check connectivity via MQTT
   * Sends ping command and waits for response (timeout: 5s)
   */
  // SENSOR-LOW-002: gate the device-command surface at the operator floor,
  // consistent with reboot/maintenance/scan (was ungated).
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => PingResult, { name: 'pingEdgeDevice' })
  async pingEdgeDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<PingResult> {
    this.logger.debug(`Pinging edge device: ${id}`);
    return await this.edgeDeviceService.pingDevice(id, tenantId);
  }

  /**
   * Reboot an edge device
   */
  @Mutation(() => Boolean, { name: 'rebootEdgeDevice' })
  @Roles(Role.TENANT_ADMIN)
  async rebootEdgeDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @Args('reason', { type: () => String, nullable: true }) reason?: string,
  ): Promise<boolean> {
    this.logger.log(`Rebooting edge device: ${id}, reason: ${reason || 'User requested'}`);
    return await this.edgeDeviceService.rebootDevice(id, tenantId, reason);
  }

  // ==================== Provisioning Mutations ====================

  /**
   * Create a new edge device with provisioning token
   * Returns installer URL and command for zero-touch setup
   */
  @Mutation(() => ProvisionedDeviceResponse, { name: 'createProvisionedDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createProvisionedDevice(
    @Args('input') input: CreateProvisionedDeviceInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<ProvisionedDeviceResponse> {
    this.logger.log(`Creating provisioned device for tenant: ${tenantId}`);
    return await this.provisioningService.createProvisionedDevice(tenantId, input, user.sub);
  }

  /**
   * Regenerate provisioning token for an existing device
   * Only works for devices that haven't been activated yet
   */
  @Mutation(() => RegenerateTokenResponse, { name: 'regenerateDeviceToken' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async regenerateDeviceToken(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<RegenerateTokenResponse> {
    this.logger.log(`Regenerating token for device: ${deviceId}`);
    return await this.provisioningService.regenerateToken(deviceId, tenantId);
  }

  /**
   * Reset a previously activated device for re-provisioning.
   * Generates a new token and returns the installer URL/command.
   */
  @Mutation(() => RegenerateTokenResponse, { name: 'resetDeviceForReprovisioning' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async resetDeviceForReprovisioning(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<RegenerateTokenResponse> {
    this.logger.log(`Resetting device ${deviceId} for re-provisioning`);
    return await this.provisioningService.resetForReprovisioning(deviceId, tenantId);
  }

  // ==================== Tenant Provisioning Key Mutations ====================

  /**
   * Create a tenant-level provisioning key for self-registration
   * Returns installer URL and command that works on any device
   */
  @Mutation(() => TenantKeyResponse, { name: 'createTenantProvisioningKey' })
  @Roles(Role.TENANT_ADMIN)
  async createTenantProvisioningKey(
    @Args('input') input: CreateTenantKeyInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<TenantKeyResponse> {
    this.logger.log(`Creating tenant provisioning key for tenant: ${tenantId}`);
    return await this.provisioningService.createTenantKey(tenantId, input, user.sub);
  }

  /**
   * Revoke a tenant provisioning key
   */
  @Mutation(() => Boolean, { name: 'revokeTenantProvisioningKey' })
  @Roles(Role.TENANT_ADMIN)
  async revokeTenantProvisioningKey(
    @Args('keyId', { type: () => ID }) keyId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Revoking tenant provisioning key: ${keyId}`);
    return await this.provisioningService.revokeTenantKey(keyId, tenantId);
  }

  /**
   * List all tenant provisioning keys
   */
  @Query(() => [TenantProvisioningKey], { name: 'tenantProvisioningKeys' })
  @Roles(Role.TENANT_ADMIN)
  async listTenantProvisioningKeys(@Tenant() tenantId: string): Promise<TenantProvisioningKey[]> {
    return await this.provisioningService.listTenantKeys(tenantId);
  }

  /**
   * Get device events with pagination
   */
  @Query(() => DeviceEventConnection, { name: 'deviceEvents' })
  async getDeviceEvents(
    @Tenant() tenantId: string,
    @Args('deviceId', { type: () => ID, nullable: true }) deviceId?: string,
    @Args('eventType', { type: () => String, nullable: true }) eventType?: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<DeviceEventConnection> {
    return this.provisioningService.getDeviceEvents(tenantId, deviceId, eventType, page, limit);
  }

  // ==================== I/O Configuration Mutations ====================

  /**
   * Add I/O configuration to a device
   */
  @Mutation(() => DeviceIoConfig, { name: 'addDeviceIoConfig' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @RequireTenantPermission('edge:manage-io-config')
  async addDeviceIoConfig(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Args('input') input: AddIoConfigInput,
    @Tenant() tenantId: string,
  ): Promise<DeviceIoConfig> {
    return await this.edgeDeviceService.addIoConfig(deviceId, tenantId, input);
  }

  /**
   * Update I/O configuration
   */
  @Mutation(() => DeviceIoConfig, { name: 'updateDeviceIoConfig' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @RequireTenantPermission('edge:manage-io-config')
  async updateDeviceIoConfig(
    @Args('id', { type: () => ID }) id: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Args('input') input: UpdateIoConfigInput,
    @Tenant() tenantId: string,
  ): Promise<DeviceIoConfig> {
    return await this.edgeDeviceService.updateIoConfig(id, deviceId, tenantId, input);
  }

  /**
   * Remove I/O configuration
   */
  @Mutation(() => Boolean, { name: 'removeDeviceIoConfig' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @RequireTenantPermission('edge:manage-io-config')
  async removeDeviceIoConfig(
    @Args('id', { type: () => ID }) id: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return await this.edgeDeviceService.removeIoConfig(id, deviceId, tenantId);
  }

  /**
   * Push the full I/O configuration to a device via MQTT
   * Transforms DB configs to agent format and sends update_io_config command
   */
  @Mutation(() => PushIoConfigResult, { name: 'pushIoConfigToDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @RequireTenantPermission('edge:manage-io-config')
  async pushIoConfigToDevice(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<PushIoConfigResult> {
    this.logger.log(`Pushing I/O config to device: ${deviceId}`);
    return await this.edgeDeviceService.pushIoConfigToDevice(deviceId, tenantId);
  }

  // ==================== Digital Output Control ====================

  /**
   * Set a digital output on an edge device
   * Process editor'dan DO tag'ini ON/OFF yapmak için.
   * Sadece DO tipi tag'lere izin verir — güvenlik katmanı.
   *
   * @Roles — TENANT_ADMIN ve MODULE_MANAGER yetkileri gerekli.
   *          Fiziksel çıkış kontrolü kritik bir operasyon olduğu için
   *          diğer write mutation'larla aynı yetki seviyesinde olmalı.
   * @CurrentUser — Audit trail için operatörün userId'si kaydedilir.
   */
  // SENSOR-HIGH-022: physically actuating a digital output requires the same
  // fine-grained I/O permission as editing I/O config (now enforced — the
  // guard is wired globally), not merely the operator role.
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @RequireTenantPermission('edge:manage-io-config')
  @Mutation(() => SetDigitalOutputResult, { name: 'setDigitalOutput' })
  async setDigitalOutput(
    @Args('input') input: SetDigitalOutputInput,
    @Tenant() tenantId: string,
    @CurrentUser() userId: string,
  ): Promise<SetDigitalOutputResult> {
    this.logger.log(
      `Setting digital output: device=${input.deviceId}, io=${input.ioConfigId}, value=${input.value}, user=${userId}`,
    );
    return await this.edgeDeviceService.setDigitalOutput(
      input.deviceId,
      input.ioConfigId,
      input.value,
      tenantId,
      userId,
    );
  }

  // ==================== I/O Auto-Detection (v2.3) ====================

  /**
   * Scan edge device hardware for available I/O channels.
   *
   * Sends a `scan_hardware` command to the agent via MQTT and waits
   * for the response (15s timeout). The agent performs platform-specific
   * enumeration:
   * - RevPi: piControl process image (piTest -d)
   * - RPi: BCM GPIO 2-27 enumeration
   * - Generic Linux: /sys/class/gpio sysfs
   *
   * The returned channels can be bulk-imported via `bulkAddDeviceIoConfigs`.
   */
  @Mutation(() => HardwareScanResultType, { name: 'scanEdgeDeviceHardware' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async scanEdgeDeviceHardware(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<HardwareScanResultType> {
    this.logger.log(`Scanning hardware on device: ${deviceId}`);
    return await this.edgeDeviceService.scanHardware(deviceId, tenantId);
  }

  /**
   * Bulk add I/O configurations to a device.
   *
   * Typically used after `scanEdgeDeviceHardware` to import discovered
   * channels. Skips duplicates (existing tagName) and reports results.
   */
  @Mutation(() => BulkAddIoConfigResult, { name: 'bulkAddDeviceIoConfigs' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @RequireTenantPermission('edge:manage-io-config')
  async bulkAddDeviceIoConfigs(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Args('inputs', { type: () => [AddIoConfigInput] }) inputs: AddIoConfigInput[],
    @Tenant() tenantId: string,
  ): Promise<BulkAddIoConfigResult> {
    this.logger.log(`Bulk adding ${inputs.length} I/O configs to device: ${deviceId}`);
    return await this.edgeDeviceService.bulkAddIoConfigs(deviceId, tenantId, inputs);
  }

  // ==================== LoRaWAN Device Management ====================

  /**
   * List all LoRa end-devices attached to an edge gateway.
   * Edge device'a bağlı SX1302 concentrator üzerinden yönetilen cihazlar.
   */
  @Query(() => [LoRaDeviceType], { name: 'loraDevices' })
  async getLoRaDevices(
    @Args('edgeDeviceId', { type: () => ID }) edgeDeviceId: string,
    @Tenant() tenantId: string,
  ): Promise<LoRaDevice[]> {
    return await this.edgeDeviceService.getLoRaDevices(edgeDeviceId, tenantId);
  }

  /**
   * Add a LoRa end-device to an edge gateway.
   * DevEUI globally unique olmalı — duplicate kayıt ConflictException fırlatır.
   */
  @Mutation(() => LoRaDeviceType, { name: 'addLoRaDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addLoRaDevice(
    @Args('edgeDeviceId', { type: () => ID }) edgeDeviceId: string,
    @Args('input') input: AddLoRaDeviceInput,
    @Tenant() tenantId: string,
  ): Promise<LoRaDevice> {
    this.logger.log(
      `Adding LoRa device: ${input.name} (DevEUI: ${input.devEui}) to edge ${edgeDeviceId}`,
    );
    return await this.edgeDeviceService.addLoRaDevice(edgeDeviceId, tenantId, input);
  }

  /**
   * Remove a LoRa device by ID.
   * Frontend edgeDeviceId + loraDeviceId gönderir — config push için edgeDeviceId gerekli.
   */
  @Mutation(() => Boolean, { name: 'removeLoRaDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeLoRaDevice(
    @Args('edgeDeviceId', { type: () => ID }) edgeDeviceId: string,
    @Args('loraDeviceId', { type: () => ID }) loraDeviceId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Removing LoRa device: ${loraDeviceId} from edge ${edgeDeviceId}`);
    return await this.edgeDeviceService.removeLoRaDevice(edgeDeviceId, loraDeviceId, tenantId);
  }

  /**
   * Send a downlink payload to a LoRa end-device.
   *
   * Class A cihazlarda payload, bir sonraki uplink'in RX window'unda iletilir.
   * Class C cihazlarda hemen gönderilir. fPort uygulama katmanı portudur (1-223).
   */
  @Mutation(() => SendLoRaDownlinkResult, { name: 'sendLoRaDownlink' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async sendLoRaDownlink(
    @Args('edgeDeviceId', { type: () => ID }) edgeDeviceId: string,
    @Args('loraDeviceId', { type: () => ID }) loraDeviceId: string,
    @Args('input') input: SendLoRaDownlinkInput,
    @Tenant() tenantId: string,
  ): Promise<SendLoRaDownlinkResult> {
    this.logger.log(
      `Sending LoRa downlink to device: ${loraDeviceId} via edge ${edgeDeviceId}, fPort: ${input.fPort}`,
    );
    return await this.edgeDeviceService.sendLoRaDownlink(
      edgeDeviceId,
      loraDeviceId,
      input.payload,
      input.fPort ?? 1,
      tenantId,
      input.confirmed ?? false,
    );
  }

  // ==================== OTA Firmware Update ====================

  /**
   * List firmware versions approved by the signed Edge release registry.
   */
  @Query(() => [FirmwareVersionInfo], { name: 'availableFirmwareVersions' })
  getAvailableFirmwareVersions(@Tenant() _tenantId: string): FirmwareVersionInfo[] {
    return this.edgeDeviceService.getAvailableFirmwareVersions();
  }

  /**
   * Trigger OTA firmware update on a single edge device
   */
  @Mutation(() => Boolean, { name: 'updateEdgeDeviceFirmware' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateEdgeDeviceFirmware(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @Args('targetVersion', { nullable: true }) targetVersion?: string,
  ): Promise<boolean> {
    this.logger.log(
      `Legacy firmware update requested for device: ${id}, version: ${targetVersion ?? 'explicit-version-required'}`,
    );
    await this.edgeDeviceService.updateDeviceFirmware(id, tenantId, targetVersion);
    return true;
  }

  /**
   * Trigger OTA firmware update on multiple edge devices
   */
  @Mutation(() => BulkFirmwareUpdateResult, { name: 'bulkUpdateEdgeDeviceFirmware' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async bulkUpdateEdgeDeviceFirmware(
    @Args('deviceIds', { type: () => [ID] }) deviceIds: string[],
    @Tenant() tenantId: string,
    @Args('targetVersion', { nullable: true }) targetVersion?: string,
  ): Promise<BulkFirmwareUpdateResult> {
    this.logger.log(
      `Bulk legacy firmware update requested for ${deviceIds.length} devices, version: ${targetVersion ?? 'explicit-version-required'}`,
    );
    return await this.edgeDeviceService.bulkUpdateDeviceFirmware(
      deviceIds,
      tenantId,
      targetVersion,
    );
  }

  // ==================== Field Resolvers ====================

  /**
   * Resolve I/O configurations for a device
   */
  @ResolveField(() => [DeviceIoConfig], { name: 'ioConfig' })
  async resolveIoConfig(
    @Parent() device: EdgeDevice,
    @Tenant() tenantId: string,
  ): Promise<DeviceIoConfig[]> {
    return await this.edgeDeviceService.getIoConfigs(device.id, tenantId);
  }

  /**
   * Resolve sensor count for a device
   * Counts sensors that share the same siteId as the device
   * (Direct device-sensor relation can be added in future if needed)
   */
  @ResolveField(() => Int, { name: 'sensorCount', nullable: true })
  async resolveSensorCount(@Parent() device: EdgeDevice): Promise<number> {
    // If device has no siteId, return 0
    if (!device.siteId) {
      return 0;
    }

    try {
      // Count active sensors on the same site as this device
      return await this.sensorRepo.count({
        where: {
          tenantId: device.tenantId,
          siteId: device.siteId,
          status: SensorStatus.ACTIVE,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to count sensors for device ${device.id}: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * Resolve program count for a device
   * Counts automation programs deployed to or targeting this device
   */
  @ResolveField(() => Int, { name: 'programCount', nullable: true })
  async resolveProgramCount(@Parent() device: EdgeDevice): Promise<number> {
    try {
      // Count programs assigned to this device (deployed or approved)
      return await this.automationProgramRepo.count({
        where: {
          tenantId: device.tenantId,
          deviceId: device.id,
          status: ProgramStatus.DEPLOYED,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to count programs for device ${device.id}: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * Resolve active alarm count for a device
   * Counts unacknowledged alarms from sensors/PLCs on the same site
   */
  @ResolveField(() => Int, { name: 'activeAlarmCount', nullable: true })
  async resolveActiveAlarmCount(@Parent() device: EdgeDevice): Promise<number> {
    try {
      // Count unacknowledged alarms for this tenant
      // Note: When PLC-EdgeDevice relation is established, filter by device
      return await this.plcAlarmRepo.count({
        where: {
          tenantId: device.tenantId,
          acknowledged: false,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to count alarms for device ${device.id}: ${(error as Error).message}`,
      );
      return 0;
    }
  }
}
