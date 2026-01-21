import { Logger } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { Tenant, CurrentUser, Roles, Role } from '@platform/backend-common';

import {
  RegisterEdgeDeviceInput,
  UpdateEdgeDeviceInput,
  AddIoConfigInput,
  UpdateIoConfigInput,
  EdgeDeviceConnection,
  EdgeDeviceStats,
  PingResult,
} from './dto/edge-device.dto';
import {
  CreateProvisionedDeviceInput,
  ProvisionedDeviceResponse,
  RegenerateTokenResponse,
} from './dto/provisioning.dto';
import { EdgeDeviceService } from './edge-device.service';
import { DeviceIoConfig } from './entities/device-io-config.entity';
import { EdgeDevice, DeviceLifecycleState } from './entities/edge-device.entity';
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
    const result = await this.edgeDeviceService.findAll(tenantId, {
      siteId,
      lifecycleState,
      isOnline,
      search,
      page,
      limit,
    });

    return {
      items: result.items,
      total: result.total,
      page: page || 1,
      limit: limit || 20,
    };
  }

  /**
   * Get edge device statistics for dashboard
   */
  @Query(() => EdgeDeviceStats, { name: 'edgeDeviceStats' })
  async getEdgeDeviceStats(
    @Tenant() tenantId: string,
  ): Promise<EdgeDeviceStats> {
    return await this.edgeDeviceService.getStats(tenantId);
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
    @Args('reason', { type: () => String, nullable: true }) reason?: string,
    @Tenant() tenantId?: string,
  ): Promise<boolean> {
    if (!tenantId) {
      throw new Error('Tenant context is required');
    }
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
    return await this.provisioningService.createProvisionedDevice(
      tenantId,
      input,
      user.sub,
    );
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

  // ==================== I/O Configuration Mutations ====================

  /**
   * Add I/O configuration to a device
   */
  @Mutation(() => DeviceIoConfig, { name: 'addDeviceIoConfig' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
  async removeDeviceIoConfig(
    @Args('id', { type: () => ID }) id: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return await this.edgeDeviceService.removeIoConfig(id, deviceId, tenantId);
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
   * TODO: Implement when sensor-edgeDevice relation is added
   */
  @ResolveField(() => Int, { name: 'sensorCount', nullable: true })
  resolveSensorCount(
    @Parent() _device: EdgeDevice,
  ): number {
    // Placeholder - will be implemented when sensor relation is added
    return 0;
  }

  /**
   * Resolve program count for a device
   * TODO: Implement when automation module is added
   */
  @ResolveField(() => Int, { name: 'programCount', nullable: true })
  resolveProgramCount(
    @Parent() _device: EdgeDevice,
  ): number {
    // Placeholder - will be implemented in Sprint 3
    return 0;
  }

  /**
   * Resolve active alarm count for a device
   * TODO: Implement when alarm module is added
   */
  @ResolveField(() => Int, { name: 'activeAlarmCount', nullable: true })
  resolveActiveAlarmCount(
    @Parent() _device: EdgeDevice,
  ): number {
    // Placeholder - will be implemented in Sprint 2
    return 0;
  }
}
