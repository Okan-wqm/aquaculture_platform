import { randomUUID } from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Optional,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, FindOptionsWhere, ILike } from 'typeorm';

import { MqttClientService } from '../shared-mqtt/mqtt-client.service';

import { DeviceIoConfig, IoType, IoDataType } from './entities/device-io-config.entity';
import {
  EdgeDevice,
  DeviceLifecycleState,
  DeviceModel,
} from './entities/edge-device.entity';


/**
 * Input type for registering a new edge device
 */
export interface RegisterEdgeDeviceInput {
  siteId?: string;
  deviceCode: string;
  deviceName: string;
  deviceModel: DeviceModel;
  serialNumber?: string;
  description?: string;
  timezone?: string;
}

/**
 * Input type for updating an edge device
 */
export interface UpdateEdgeDeviceInput {
  deviceName?: string;
  description?: string;
  siteId?: string;
  timezone?: string;
  scanRateMs?: number;
  config?: Record<string, unknown>;
  capabilities?: Record<string, boolean>;
  tags?: string[];
}

/**
 * Input type for adding I/O configuration
 */
export interface AddIoConfigInput {
  tagName: string;
  description?: string;
  ioType: IoType;
  dataType: IoDataType;
  moduleAddress: number;
  channel: number;
  rawMin?: number;
  rawMax?: number;
  engMin?: number;
  engMax?: number;
  engUnit?: string;
  modbusFunction?: number;
  modbusSlaveId?: number;
  modbusRegister?: number;
  gpioPin?: number;
  gpioMode?: string;
  invertValue?: boolean;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
  deadband?: number;
}

/**
 * Device statistics type
 */
export interface EdgeDeviceStats {
  total: number;
  online: number;
  offline: number;
  byState: Array<{ state: DeviceLifecycleState; count: number }>;
  byModel: Array<{ model: DeviceModel; count: number }>;
}

/**
 * Device heartbeat data from MQTT
 */
export interface DeviceHeartbeat {
  deviceCode: string;
  tenantId?: string;
  isOnline: boolean;
  cpuUsage?: number;
  memoryUsage?: number;
  storageUsage?: number;
  temperatureCelsius?: number;
  uptimeSeconds?: number;
  firmwareVersion?: string;
  ipAddress?: string;
}

/**
 * Ping result from edge device
 */
export interface PingResult {
  success: boolean;
  latencyMs?: number;
  deviceCode: string;
  timestamp: Date;
  error?: string;
}

/**
 * Pending ping request for tracking responses
 */
interface PendingPing {
  commandId: string;
  deviceCode: string;
  startTime: number;
  resolve: (result: PingResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Edge Device Service
 * Manages industrial edge controllers (Revolution Pi, Raspberry Pi, etc.)
 *
 * SOLID Principles:
 * - Single Responsibility: Device lifecycle management
 * - Open/Closed: Extensible via interfaces
 * - Dependency Inversion: Optional MQTT injection
 */
@Injectable()
export class EdgeDeviceService implements OnModuleDestroy {
  private readonly logger = new Logger(EdgeDeviceService.name);
  private readonly pendingPings: Map<string, PendingPing> = new Map();
  private readonly PING_TIMEOUT_MS = 5000; // 5 seconds
  private readonly CLEANUP_INTERVAL_MS = 60000; // 1 minute
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(
    @InjectRepository(EdgeDevice)
    private readonly deviceRepository: Repository<EdgeDevice>,
    @InjectRepository(DeviceIoConfig)
    private readonly ioConfigRepository: Repository<DeviceIoConfig>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional()
    private readonly mqttClient: MqttClientService | null,
  ) {
    // Start periodic cleanup of stale pending pings
    this.startPendingPingsCleanup();
  }

  /**
   * Lifecycle: Clean up resources on module destroy
   * Prevents memory leaks from pending pings and intervals
   */
  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.log('EdgeDeviceService shutting down...');

    // Stop cleanup interval
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }

    // Clear all pending pings with rejection
    this.clearAllPendingPings('Service shutting down');

    this.logger.log('EdgeDeviceService cleanup complete');
  }

  /**
   * Start periodic cleanup of stale pending pings
   * Prevents memory buildup from abandoned ping requests
   */
  private startPendingPingsCleanup(): void {
    this.cleanupIntervalId = setInterval(() => {
      if (this.isShuttingDown) return;
      this.cleanupStalePendingPings();
    }, this.CLEANUP_INTERVAL_MS);

    // Ensure interval doesn't prevent process exit
    this.cleanupIntervalId.unref();
  }

  /**
   * Clean up stale pending pings that exceeded timeout
   * Safety net for pings that weren't properly cleared
   */
  private cleanupStalePendingPings(): void {
    const now = Date.now();
    const staleThreshold = this.PING_TIMEOUT_MS * 2; // 2x timeout as safety margin

    for (const [commandId, pending] of this.pendingPings) {
      if (now - pending.startTime > staleThreshold) {
        this.logger.warn(`Cleaning up stale pending ping: ${commandId}`);
        clearTimeout(pending.timeout);
        this.pendingPings.delete(commandId);

        // Resolve with timeout error (don't reject to avoid unhandled rejections)
        pending.resolve({
          success: false,
          deviceCode: pending.deviceCode,
          timestamp: new Date(),
          error: 'Ping request expired (cleanup)',
        });
      }
    }
  }

  /**
   * Clear all pending pings with a specific error message
   */
  private clearAllPendingPings(errorMessage: string): void {
    for (const [commandId, pending] of this.pendingPings) {
      clearTimeout(pending.timeout);
      pending.resolve({
        success: false,
        deviceCode: pending.deviceCode,
        timestamp: new Date(),
        error: errorMessage,
      });
    }
    this.pendingPings.clear();
    this.logger.debug(`Cleared ${this.pendingPings.size} pending pings`);
  }

  /**
   * Register a new edge device
   */
  async registerDevice(
    tenantId: string,
    input: RegisterEdgeDeviceInput,
    createdBy?: string,
  ): Promise<EdgeDevice> {
    // Check for duplicate device code
    const existing = await this.deviceRepository.findOne({
      where: { deviceCode: input.deviceCode },
    });
    if (existing) {
      throw new ConflictException(
        `Device with code '${input.deviceCode}' already exists`,
      );
    }

    // Check for duplicate serial number if provided
    if (input.serialNumber) {
      const existingSerial = await this.deviceRepository.findOne({
        where: { serialNumber: input.serialNumber },
      });
      if (existingSerial) {
        throw new ConflictException(
          `Device with serial number '${input.serialNumber}' already exists`,
        );
      }
    }

    // Generate MQTT client ID
    const mqttClientId = `edge-${tenantId.substring(0, 8)}-${input.deviceCode}`.toLowerCase();

    const device = this.deviceRepository.create({
      tenantId,
      ...input,
      mqttClientId,
      lifecycleState: DeviceLifecycleState.REGISTERED,
      isOnline: false,
      securityLevel: 2, // Default IEC 62443 SL2
      createdBy,
    });

    const saved = await this.deviceRepository.save(device);
    this.logger.log(`Registered new edge device: ${saved.deviceCode} (${saved.id})`);
    return saved;
  }

  /**
   * Find device by ID
   */
  async findById(id: string, tenantId: string): Promise<EdgeDevice | null> {
    return await this.deviceRepository.findOne({
      where: { id, tenantId },
    });
  }

  /**
   * Find device by ID (throws if not found)
   */
  async findByIdOrFail(id: string, tenantId: string): Promise<EdgeDevice> {
    const device = await this.findById(id, tenantId);
    if (!device) {
      throw new NotFoundException(`Edge device with ID '${id}' not found`);
    }
    return device;
  }

  /**
   * Find device by code
   */
  async findByCode(deviceCode: string, tenantId: string): Promise<EdgeDevice | null> {
    return await this.deviceRepository.findOne({
      where: { deviceCode, tenantId },
    });
  }

  /**
   * Find device by MQTT client ID
   */
  async findByMqttClientId(mqttClientId: string): Promise<EdgeDevice | null> {
    return await this.deviceRepository.findOne({
      where: { mqttClientId },
    });
  }

  /**
   * Find all devices with filtering and pagination
   */
  async findAll(
    tenantId: string,
    options?: {
      siteId?: string;
      lifecycleState?: DeviceLifecycleState;
      isOnline?: boolean;
      search?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{ items: EdgeDevice[]; total: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const where: FindOptionsWhere<EdgeDevice> = { tenantId };

    if (options?.siteId) {
      where.siteId = options.siteId;
    }
    if (options?.lifecycleState) {
      where.lifecycleState = options.lifecycleState;
    }
    if (options?.isOnline !== undefined) {
      where.isOnline = options.isOnline;
    }
    if (options?.search) {
      // Search by device code or name
      where.deviceName = ILike(`%${options.search}%`);
    }

    const [items, total] = await this.deviceRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return { items, total };
  }

  /**
   * Update device information
   */
  async updateDevice(
    id: string,
    tenantId: string,
    input: UpdateEdgeDeviceInput,
  ): Promise<EdgeDevice> {
    const device = await this.findByIdOrFail(id, tenantId);

    // Apply updates
    Object.assign(device, input);

    return await this.deviceRepository.save(device);
  }

  /**
   * Approve a registered device (move to ACTIVE state)
   */
  async approveDevice(id: string, tenantId: string, approvedBy: string): Promise<EdgeDevice> {
    const device = await this.findByIdOrFail(id, tenantId);

    if (device.lifecycleState !== DeviceLifecycleState.REGISTERED &&
        device.lifecycleState !== DeviceLifecycleState.PENDING_APPROVAL) {
      throw new BadRequestException(
        `Device in '${device.lifecycleState}' state cannot be approved`,
      );
    }

    device.lifecycleState = DeviceLifecycleState.ACTIVE;
    device.commissionedAt = new Date();
    device.commissionedBy = approvedBy;

    const saved = await this.deviceRepository.save(device);
    this.logger.log(`Device approved: ${saved.deviceCode} by ${approvedBy}`);
    return saved;
  }

  /**
   * Set device to maintenance mode
   */
  async setMaintenanceMode(id: string, tenantId: string, enabled: boolean): Promise<EdgeDevice> {
    const device = await this.findByIdOrFail(id, tenantId);

    device.lifecycleState = enabled
      ? DeviceLifecycleState.MAINTENANCE
      : DeviceLifecycleState.ACTIVE;

    return await this.deviceRepository.save(device);
  }

  /**
   * Decommission a device
   */
  async decommissionDevice(
    id: string,
    tenantId: string,
    reason: string,
  ): Promise<EdgeDevice> {
    const device = await this.findByIdOrFail(id, tenantId);

    device.lifecycleState = DeviceLifecycleState.DECOMMISSIONED;
    device.isOnline = false;
    device.config = {
      ...device.config,
      decommissionReason: reason,
      decommissionedAt: new Date().toISOString(),
    };

    const saved = await this.deviceRepository.save(device);
    this.logger.log(`Device decommissioned: ${saved.deviceCode}, reason: ${reason}`);
    return saved;
  }

  /**
   * Update device heartbeat (called from MQTT listener)
   */
  async updateHeartbeat(heartbeat: DeviceHeartbeat): Promise<EdgeDevice | null> {
    const whereCondition: Record<string, unknown> = { deviceCode: heartbeat.deviceCode };
    if (heartbeat.tenantId) {
      whereCondition.tenantId = heartbeat.tenantId;
    }
    const device = await this.deviceRepository.findOne({
      where: whereCondition,
    });

    if (!device) {
      this.logger.warn(`Heartbeat from unknown device: ${heartbeat.deviceCode}`);
      return null;
    }

    // Update device health metrics
    device.lastSeenAt = new Date();
    device.isOnline = heartbeat.isOnline;

    if (heartbeat.cpuUsage !== undefined) device.cpuUsage = heartbeat.cpuUsage;
    if (heartbeat.memoryUsage !== undefined) device.memoryUsage = heartbeat.memoryUsage;
    if (heartbeat.storageUsage !== undefined) device.storageUsage = heartbeat.storageUsage;
    if (heartbeat.temperatureCelsius !== undefined) device.temperatureCelsius = heartbeat.temperatureCelsius;
    if (heartbeat.uptimeSeconds !== undefined) device.uptimeSeconds = heartbeat.uptimeSeconds;
    if (heartbeat.firmwareVersion) device.firmwareVersion = heartbeat.firmwareVersion;
    if (heartbeat.ipAddress) device.ipAddress = heartbeat.ipAddress;

    // Update connection quality based on frequency of heartbeats
    device.connectionQuality = heartbeat.isOnline ? 100 : 0;

    // Transition state from OFFLINE if coming back online
    if (heartbeat.isOnline && device.lifecycleState === DeviceLifecycleState.OFFLINE) {
      device.lifecycleState = DeviceLifecycleState.ACTIVE;
    }

    return await this.deviceRepository.save(device);
  }

  /**
   * Mark devices as offline if no heartbeat received
   */
  async markStaleDevicesOffline(timeoutMinutes = 5): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

    const result = await this.deviceRepository
      .createQueryBuilder()
      .update(EdgeDevice)
      .set({
        isOnline: false,
        lifecycleState: DeviceLifecycleState.OFFLINE,
      })
      .where('isOnline = :online', { online: true })
      .andWhere('lastSeenAt < :cutoff', { cutoff })
      .andWhere('lifecycleState != :decommissioned', {
        decommissioned: DeviceLifecycleState.DECOMMISSIONED,
      })
      .execute();

    if (result.affected && result.affected > 0) {
      this.logger.log(`Marked ${result.affected} devices as offline`);
    }

    return result.affected || 0;
  }

  /**
   * Get device statistics for dashboard
   */
  async getStats(tenantId: string): Promise<EdgeDeviceStats> {
    interface DeviceStatsRow {
      total: string;
      online: string;
      offline: string;
      lifecycle_state: DeviceLifecycleState;
      device_model: DeviceModel;
      count: string;
    }

    const query = `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_online = true) AS online,
        COUNT(*) FILTER (WHERE is_online = false) AS offline,
        lifecycle_state,
        device_model,
        COUNT(*) AS count
      FROM edge_devices
      WHERE tenant_id = $1
      GROUP BY lifecycle_state, device_model
    `;

    const results: DeviceStatsRow[] = await this.dataSource.query(query, [tenantId]);

    // Process results
    const byState: Map<DeviceLifecycleState, number> = new Map();
    const byModel: Map<DeviceModel, number> = new Map();
    let total = 0;
    let online = 0;
    let offline = 0;

    for (const row of results) {
      const count = parseInt(row.count, 10);
      total = parseInt(row.total, 10);
      online = parseInt(row.online, 10);
      offline = parseInt(row.offline, 10);

      const existingState = byState.get(row.lifecycle_state) || 0;
      byState.set(row.lifecycle_state, existingState + count);

      const existingModel = byModel.get(row.device_model) || 0;
      byModel.set(row.device_model, existingModel + count);
    }

    return {
      total,
      online,
      offline,
      byState: Array.from(byState.entries()).map(([state, count]) => ({
        state,
        count,
      })),
      byModel: Array.from(byModel.entries()).map(([model, count]) => ({
        model,
        count,
      })),
    };
  }

  // ==================== I/O Configuration Methods ====================

  /**
   * Add I/O configuration to a device
   */
  async addIoConfig(
    deviceId: string,
    tenantId: string,
    input: AddIoConfigInput,
  ): Promise<DeviceIoConfig> {
    // Verify device exists
    await this.findByIdOrFail(deviceId, tenantId);

    // Check for duplicate tag name
    const existing = await this.ioConfigRepository.findOne({
      where: { deviceId, tagName: input.tagName },
    });
    if (existing) {
      throw new ConflictException(
        `I/O tag '${input.tagName}' already exists on this device`,
      );
    }

    const ioConfig = this.ioConfigRepository.create({
      deviceId,
      ...input,
      invertValue: input.invertValue ?? false,
      modbusSlaveId: input.modbusSlaveId ?? 1,
    });

    return await this.ioConfigRepository.save(ioConfig);
  }

  /**
   * Get all I/O configurations for a device
   */
  async getIoConfigs(deviceId: string, tenantId: string): Promise<DeviceIoConfig[]> {
    // Verify device exists
    await this.findByIdOrFail(deviceId, tenantId);

    return await this.ioConfigRepository.find({
      where: { deviceId, isActive: true },
      order: { tagName: 'ASC' },
    });
  }

  /**
   * Update I/O configuration
   */
  async updateIoConfig(
    id: string,
    deviceId: string,
    tenantId: string,
    input: Partial<AddIoConfigInput>,
  ): Promise<DeviceIoConfig> {
    // Verify device exists
    await this.findByIdOrFail(deviceId, tenantId);

    const ioConfig = await this.ioConfigRepository.findOne({
      where: { id, deviceId },
    });

    if (!ioConfig) {
      throw new NotFoundException(`I/O configuration with ID '${id}' not found`);
    }

    Object.assign(ioConfig, input);
    return await this.ioConfigRepository.save(ioConfig);
  }

  /**
   * Remove I/O configuration
   */
  async removeIoConfig(
    id: string,
    deviceId: string,
    tenantId: string,
  ): Promise<boolean> {
    // Verify device exists
    await this.findByIdOrFail(deviceId, tenantId);

    const result = await this.ioConfigRepository.delete({ id, deviceId });
    return (result.affected || 0) > 0;
  }

  /**
   * Get I/O config by tag name
   */
  async getIoConfigByTag(
    deviceId: string,
    tagName: string,
  ): Promise<DeviceIoConfig | null> {
    return await this.ioConfigRepository.findOne({
      where: { deviceId, tagName },
    });
  }

  // ==================== MQTT Command Methods ====================

  /**
   * Check if MQTT is available for commands
   * Returns the MQTT client if available, throws otherwise
   */
  private ensureMqttAvailable(): MqttClientService {
    if (!this.mqttClient) {
      throw new BadRequestException('MQTT service not available');
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      throw new BadRequestException('Not connected to MQTT broker');
    }
    return this.mqttClient;
  }

  /**
   * Ping an edge device to check connectivity
   * Sends ping command and waits for response
   */
  async pingDevice(id: string, tenantId: string): Promise<PingResult> {
    const device = await this.findByIdOrFail(id, tenantId);
    const mqtt = this.ensureMqttAvailable();

    const commandId = randomUUID();
    const startTime = Date.now();

    // Create a promise that will resolve when response is received
    const pingPromise = new Promise<PingResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPings.delete(commandId);
        resolve({
          success: false,
          deviceCode: device.deviceCode,
          timestamp: new Date(),
          error: 'Ping timeout - device did not respond',
        });
      }, this.PING_TIMEOUT_MS);

      this.pendingPings.set(commandId, {
        commandId,
        deviceCode: device.deviceCode,
        startTime,
        resolve,
        reject,
        timeout,
      });
    });

    // Publish ping command using tenant-scoped topic for proper ACL enforcement
    try {
      await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
        commandId,
        command: 'ping',
        timestamp: new Date().toISOString(),
      });
      this.logger.debug(`Ping sent to ${device.deviceCode} (${commandId})`);
    } catch (error) {
      // Clean up pending ping if publish fails
      const pending = this.pendingPings.get(commandId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingPings.delete(commandId);
      }
      throw new BadRequestException(`Failed to send ping: ${(error as Error).message}`);
    }

    return pingPromise;
  }

  /**
   * Handle ping response from edge device
   * Called by MqttListenerService when response is received
   */
  handlePingResponse(deviceCode: string, payload: Record<string, unknown>): void {
    const commandId = payload.commandId as string;
    if (!commandId) {
      this.logger.warn(`Ping response without commandId from ${deviceCode}`);
      return;
    }

    const pending = this.pendingPings.get(commandId);
    if (!pending) {
      this.logger.debug(`Ping response for unknown/expired command: ${commandId}`);
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingPings.delete(commandId);

    const latencyMs = Date.now() - pending.startTime;
    this.logger.debug(`Ping response from ${deviceCode}: ${latencyMs}ms`);

    pending.resolve({
      success: true,
      latencyMs,
      deviceCode,
      timestamp: new Date(),
    });
  }

  /**
   * Send reboot command to edge device
   */
  async rebootDevice(id: string, tenantId: string, reason?: string): Promise<boolean> {
    const device = await this.findByIdOrFail(id, tenantId);
    const mqtt = this.ensureMqttAvailable();

    // Only allow reboot for active/maintenance devices
    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      throw new BadRequestException('Cannot reboot decommissioned device');
    }

    try {
      // Sanitize reason to prevent log injection
      const safeReason = (reason || 'User requested reboot').replace(/[^a-zA-Z0-9 ._\-]/g, '').substring(0, 200);
      // Publish using tenant-scoped topic for proper ACL enforcement
      await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
        commandId: randomUUID(),
        command: 'reboot',
        reason: safeReason,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Reboot command sent to ${device.deviceCode}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send reboot to ${device.deviceCode}: ${(error as Error).message}`);
      throw new BadRequestException(`Failed to send reboot command: ${(error as Error).message}`);
    }
  }

  /**
   * Send configuration update to edge device
   */
  async sendConfig(
    id: string,
    tenantId: string,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    const device = await this.findByIdOrFail(id, tenantId);
    const mqtt = this.ensureMqttAvailable();

    // Validate config payload size (16 KB limit)
    const configStr = JSON.stringify(config);
    if (configStr.length > 16384) {
      throw new BadRequestException('Config payload exceeds 16 KB size limit');
    }

    // Reject sensitive/dangerous config keys
    const BLOCKED_KEYS = ['mqtt_credentials', 'mqtt_password', 'firmware_update_url', 'api_key', 'secret'];
    const configKeys = Object.keys(config);
    for (const key of configKeys) {
      if (BLOCKED_KEYS.some(blocked => key.toLowerCase().includes(blocked))) {
        throw new BadRequestException(`Config key "${key}" is not allowed via this endpoint`);
      }
    }

    try {
      // Publish using tenant-scoped topic for proper ACL enforcement
      await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
        commandId: randomUUID(),
        command: 'config',
        config,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Config update sent to ${device.deviceCode}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send config to ${device.deviceCode}: ${(error as Error).message}`);
      throw new BadRequestException(`Failed to send config: ${(error as Error).message}`);
    }
  }
}
