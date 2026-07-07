import { randomUUID } from 'crypto';

import {
  getTenantSchemaName,
  listTenantSchemas,
  pinTenantSchemaTransactionSearchPath,
} from '@aquaculture/backend-common/database';
import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, FindOptionsWhere, ILike } from 'typeorm';

import { MqttClientService } from '../shared-mqtt/mqtt-client.service';

import { DeviceIoConfig, IoType, IoDataType } from './entities/device-io-config.entity';
import { EdgeDevice, DeviceLifecycleState, DeviceModel, isTerminalLifecycleState } from './entities/edge-device.entity';
import { LoRaDevice, LoRaActivationMode, LoRaDeviceClass } from './entities/lora-device.entity';
import { InstallerScriptService } from './installer-script.service';

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
  busType?: string;
  i2cBus?: number;
  i2cAddress?: number;
  spiBus?: number;
  spiCs?: number;
  uartPort?: string;
  driverType?: string;
  invertValue?: boolean;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
  deadband?: number;
}

type DeviceIoConfigWithGpioPin = DeviceIoConfig & { gpioPin: number };
type DeviceIoConfigWithI2cAddress = DeviceIoConfig & { i2cAddress: number };
type DeviceIoConfigWithModbusRegister = DeviceIoConfig & { modbusRegister: number };

interface EdgeDeviceFingerprint {
  cpuSerial?: string;
  macAddresses?: string[];
  machineId?: string;
  hostname?: string;
}

type RowValueMap = Record<string, unknown>;

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
  status?: string;
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

// ============================================================================
// Agent Wire Format Types
// These interfaces mirror the Rust serde structs in config.rs.
// Field names use snake_case to match the JSON the agent deserialises.
// Keep in sync with: sens-api-gateway/src/config.rs
// ============================================================================

/** Matches config.rs → ModbusRegisterConfig.register_type */
type AgentRegisterType = 'coil' | 'discrete_input' | 'holding' | 'input';

/** Matches config.rs → ModbusRegisterConfig */
// The v1 device-level wire shapes (ModbusDeviceConfig / GpioConfig /
// I2cDeviceConfig mirrors of config.rs) were retired with the
// schemaVersion-2 flat-tag transform: v2 emits per-tag protocol fields
// (slaveId/register/pin/bus...) and no device-level connection blocks.
// tools/gates/fixtures/agent-io-config-v2.golden.json is the wire SSoT.

// ============================================================================
// LoRaWAN Agent Wire Format
// Matches config.rs → LoRaWanConfig / LoRaDeviceConfig
// snake_case field names — Rust serde deserialise uyumu için.
// ============================================================================

/**
 * Matches config.rs → LoRaDeviceConfig
 *
 * Her LoRa end-device'ın agent tarafında karşılığı.
 * Edge agent bu yapıyı kullanarak SX1302 concentrator üzerinden
 * cihazla iletişim kurar ve join/uplink işlemlerini yönetir.
 */
interface AgentLoRaDeviceConfig {
  dev_eui: string;
  app_eui: string; // Rust String — null olmaz, varsayılan '0000000000000000'
  app_key: string;
  dev_addr: string | null;
  activation: string; // Rust serde küçük harf: 'otaa' | 'abp'
  device_class: string; // Rust serde küçük harf: 'a' | 'b' | 'c'
  name: string;
  tag_prefix: string;
  codec: string;
  adr_enabled: boolean;
  f_port: number;
}

/**
 * Matches config.rs → LoRaWanConfig
 *
 * Üst seviye LoRaWAN yapılandırması. enabled=true olduğunda
 * agent, SX1302 HAL'ı başlatır ve devices listesindeki cihazları yönetir.
 */
export interface AgentLoRaWanConfig {
  enabled: boolean;
  devices: AgentLoRaDeviceConfig[];
}

/** Top-level I/O config payload sent to the agent via MQTT */
interface AgentIoTagConfig {
  tagName: string;
  protocol: 'gpio' | 'modbus' | 'i2c';
  ioType: string;
  dataType: string;
  rawMin: number | null;
  rawMax: number | null;
  engMin: number | null;
  engMax: number | null;
  engUnit: string | null;
  invert: boolean;
  alarmHH: number | null;
  alarmH: number | null;
  alarmL: number | null;
  alarmLL: number | null;
  deadband: number | null;
  pin?: number;
  slaveId?: number;
  register?: number;
  function?: number;
  registerType?: AgentRegisterType;
  bus?: number;
  address?: number;
  driverType?: string;
  sensorType?: string | null;
}

export interface AgentIoConfig {
  schemaVersion: 2;
  tags: AgentIoTagConfig[];
  lorawan?: AgentLoRaWanConfig;
}

/**
 * Pending ping request for tracking responses
 */
interface PendingPing {
  commandId: string;
  deviceId: string;
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
    @InjectRepository(LoRaDevice)
    private readonly loraDeviceRepository: Repository<LoRaDevice>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional()
    @Inject(MqttClientService)
    private readonly mqttClient: MqttClientService | null,
    private readonly installerScriptService: InstallerScriptService,
    private readonly configService: ConfigService,
  ) {
    // Start periodic cleanup of stale pending pings
    this.startPendingPingsCleanup();
  }

  private static isRecord(value: unknown): value is RowValueMap {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private static queryAffectedRows(result: unknown): number {
    if (!EdgeDeviceService.isRecord(result)) {
      return 0;
    }

    const rowCount = result.rowCount;
    if (typeof rowCount === 'number') {
      return rowCount;
    }

    const affected = result.affected;
    return typeof affected === 'number' ? affected : 0;
  }

  private isLegacyOtaAllowed(): boolean {
    return (
      this.configService.get<string>('EDGE_LEGACY_OTA_ALLOWED', 'false').toLowerCase() === 'true'
    );
  }

  /**
   * Lifecycle: Clean up resources on module destroy
   * Prevents memory leaks from pending pings and intervals
   */
  onModuleDestroy(): void {
    this.isShuttingDown = true;
    this.logger.log('EdgeDeviceService shutting down...');

    // Stop cleanup interval
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }

    // Clear all pending pings with rejection
    this.clearAllPendingPings('Service shutting down');

    // Clear all pending scans with timeout resolution
    for (const [, pending] of this.pendingScans) {
      clearTimeout(pending.timeout);
      pending.resolve({
        success: false,
        error: 'Service shutting down',
        platform: 'Unknown',
        discoveredChannels: [],
        totalFound: 0,
      });
    }
    this.pendingScans.clear();

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
    for (const [, pending] of this.pendingPings) {
      clearTimeout(pending.timeout);
      pending.resolve({
        success: false,
        deviceCode: pending.deviceCode,
        timestamp: new Date(),
        error: errorMessage,
      });
    }
    const pingCount = this.pendingPings.size;
    this.pendingPings.clear();
    this.logger.debug(`Cleared ${pingCount} pending pings`);
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
      throw new ConflictException(`Device with code '${input.deviceCode}' already exists`);
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
   * Find device by code only (no tenant filter).
   * Used by legacy edge/ topic handler to resolve the device's tenantId
   * for tenant enforcement on topics that lack a tenant prefix.
   */
  async findByCodeOnly(deviceCode: string): Promise<EdgeDevice | null> {
    return await this.deviceRepository.findOne({
      where: { deviceCode },
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
  ): Promise<IStandardPaginatedResult<EdgeDevice>> {
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

    return createStandardPaginatedResult(items, total, page, limit);
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

    if (
      device.lifecycleState !== DeviceLifecycleState.REGISTERED &&
      device.lifecycleState !== DeviceLifecycleState.PENDING_APPROVAL
    ) {
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

    // SENSOR-MEDIUM-008: REVOKED is terminal too.
    if (isTerminalLifecycleState(device.lifecycleState)) {
      throw new BadRequestException(
        `Cannot change maintenance mode of a device in a terminal state (${device.lifecycleState})`,
      );
    }

    device.lifecycleState = enabled
      ? DeviceLifecycleState.MAINTENANCE
      : DeviceLifecycleState.ACTIVE;

    return await this.deviceRepository.save(device);
  }

  /**
   * Decommission a device
   */
  async decommissionDevice(id: string, tenantId: string, reason: string): Promise<EdgeDevice> {
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
    // Device identifier from MQTT topic can be either deviceCode (e.g. "PI-A36C09D4")
    // or device UUID (e.g. "0cfb7dad-..."). The edge agent uses UUID in topic paths.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      heartbeat.deviceCode,
    );

    // Use tenant-scoped query when tenantId is available (MQTT listener always provides it)
    let device: EdgeDevice | null = null;
    const tenantSchema = heartbeat.tenantId ? this.getTenantSchemaFromId(heartbeat.tenantId) : null;

    if (tenantSchema) {
      const column = isUuid ? 'id' : 'device_code';
      const rows = await this.dataSource.query<RowValueMap[]>(
        `SELECT * FROM "${tenantSchema}".edge_devices WHERE "${column}" = $1 LIMIT 1`,
        [heartbeat.deviceCode],
      );
      const firstRow = rows[0];
      if (firstRow) {
        device = this.mapRowToEdgeDevice(firstRow);
      }
    } else {
      const whereCondition: Record<string, unknown> = isUuid
        ? { id: heartbeat.deviceCode }
        : { deviceCode: heartbeat.deviceCode };
      device = await this.deviceRepository.findOne({ where: whereCondition });
    }

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
    if (heartbeat.temperatureCelsius !== undefined)
      device.temperatureCelsius = heartbeat.temperatureCelsius;
    if (heartbeat.uptimeSeconds !== undefined) device.uptimeSeconds = heartbeat.uptimeSeconds;
    if (heartbeat.firmwareVersion) {
      device.firmwareVersion = heartbeat.firmwareVersion;

      // Check if firmware update target has been reached
      if (device.targetFirmwareVersion) {
        const normalize = (v: string): string => v.replace(/^agent-v/, '');
        if (normalize(heartbeat.firmwareVersion) === normalize(device.targetFirmwareVersion)) {
          device.firmwareUpdatedAt = new Date();
          device.targetFirmwareVersion = undefined;
          this.logger.log(
            `Device ${device.deviceCode} firmware updated to ${heartbeat.firmwareVersion}`,
          );
        }
      }
    }
    if (heartbeat.ipAddress) device.ipAddress = heartbeat.ipAddress;

    // Update connection quality based on frequency of heartbeats
    device.connectionQuality = heartbeat.isOnline ? 100 : 0;

    // Map status string to lifecycle state (skip DECOMMISSIONED/REVOKED — those are admin-only)
    const status = heartbeat.status;
    if (status === 'error') {
      device.lifecycleState = DeviceLifecycleState.ERROR;
    } else if (status === 'maintenance') {
      device.lifecycleState = DeviceLifecycleState.MAINTENANCE;
    } else if (status === 'offline' && device.lifecycleState === DeviceLifecycleState.ACTIVE) {
      device.lifecycleState = DeviceLifecycleState.OFFLINE;
    } else if (
      heartbeat.isOnline &&
      (device.lifecycleState === DeviceLifecycleState.OFFLINE ||
        device.lifecycleState === DeviceLifecycleState.PROVISIONING)
    ) {
      // Transition to ACTIVE when device comes online from OFFLINE or PROVISIONING state
      device.lifecycleState = DeviceLifecycleState.ACTIVE;
    } else if (!heartbeat.isOnline && device.lifecycleState === DeviceLifecycleState.ACTIVE) {
      // Transition to OFFLINE when device goes offline while in ACTIVE state
      device.lifecycleState = DeviceLifecycleState.OFFLINE;
    }

    // Save using tenant-scoped query when available
    if (tenantSchema) {
      await this.dataSource.query(
        `UPDATE "${tenantSchema}".edge_devices SET
          last_seen_at = $2, is_online = $3, lifecycle_state = $4,
          cpu_usage = COALESCE($5, cpu_usage), memory_usage = COALESCE($6, memory_usage),
          storage_usage = COALESCE($7, storage_usage), temperature_celsius = COALESCE($8, temperature_celsius),
          uptime_seconds = COALESCE($9, uptime_seconds), firmware_version = COALESCE($10, firmware_version),
          ip_address = COALESCE($11, ip_address), connection_quality = $12,
          updated_at = NOW()
        WHERE id = $1`,
        [
          device.id,
          device.lastSeenAt,
          device.isOnline,
          device.lifecycleState,
          device.cpuUsage ?? null,
          device.memoryUsage ?? null,
          device.storageUsage ?? null,
          device.temperatureCelsius ?? null,
          device.uptimeSeconds ?? null,
          device.firmwareVersion ?? null,
          device.ipAddress ?? null,
          device.connectionQuality,
        ],
      );
      return device;
    }

    // SAFETY: Block writes without tenant context — would contaminate source schema
    this.logger.error(
      `BLOCKED: updateHeartbeat for device ${device.deviceCode ?? device.id} has no tenantSchema — would write to source schema`,
    );
    return device;
  }

  /**
   * Mark devices as offline if no heartbeat received.
   *
   * Iterates ALL tenant schemas so that devices in every tenant are checked,
   * not just the default search_path (which would only hit the `sensor` schema).
   */
  @Interval(60_000)
  async markStaleDevicesOffline(timeoutMinutes = 5): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    let totalAffected = 0;

    let schemas: string[];
    try {
      schemas = await listTenantSchemas(this.dataSource);
    } catch (err) {
      this.logger.error(
        `Failed to fetch tenant schemas for stale-device check: ${(err as Error).message}`,
      );
      return 0;
    }

    for (const schemaName of schemas) {
      const qr = this.dataSource.createQueryRunner();
      try {
        await qr.connect();
        await qr.startTransaction();
        await pinTenantSchemaTransactionSearchPath(qr, 'sensor', schemaName);

        const result: unknown = await qr.query(
          `UPDATE edge_devices
           SET is_online = false,
               lifecycle_state = $1
           WHERE is_online = true
             AND last_seen_at < $2
             AND lifecycle_state NOT IN ($3, $4)`,
          [
            DeviceLifecycleState.OFFLINE,
            cutoff.toISOString(),
            DeviceLifecycleState.DECOMMISSIONED,
            DeviceLifecycleState.MAINTENANCE,
          ],
        );

        const affected = EdgeDeviceService.queryAffectedRows(result);
        if (affected > 0) {
          this.logger.log(`Marked ${affected} devices as offline in ${schemaName}`);
          totalAffected += affected;
        }
        await qr.commitTransaction();
      } catch (err) {
        if (qr.isTransactionActive) {
          await qr.rollbackTransaction().catch(() => undefined);
        }
        this.logger.error(
          `Failed stale-device check for ${schemaName}: ${(err as Error).message}`,
        );
      } finally {
        await qr.release();
      }
    }

    if (totalAffected > 0) {
      this.logger.log(`Total devices marked offline across all tenants: ${totalAffected}`);
    }

    return totalAffected;
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
      throw new ConflictException(`I/O tag '${input.tagName}' already exists on this device`);
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
  async removeIoConfig(id: string, deviceId: string, tenantId: string): Promise<boolean> {
    // Verify device exists
    await this.findByIdOrFail(deviceId, tenantId);

    const result = await this.ioConfigRepository.delete({ id, deviceId });
    return (result.affected || 0) > 0;
  }

  /**
   * Get I/O config by tag name
   */
  async getIoConfigByTag(deviceId: string, tagName: string): Promise<DeviceIoConfig | null> {
    return await this.ioConfigRepository.findOne({
      where: { deviceId, tagName },
    });
  }

  // ==================== Install Commands ====================

  /**
   * Get install and uninstall commands for a device.
   * Used by the frontend device settings tab to display commands.
   */
  async getInstallCommands(
    deviceId: string,
    tenantId: string,
  ): Promise<{
    installCommand: string;
    uninstallCommand: string;
    updateCommand: string;
    installUrl: string;
    uninstallUrl: string;
    updateUrl: string;
  }> {
    const device = await this.findByIdOrFail(deviceId, tenantId);

    // SENSOR-MEDIUM-001/002: the plaintext provisioning token is never
    // recoverable from storage (only its SHA-256 digest is kept), so this
    // display path cannot embed a working token. The command shows the
    // endpoint; without the X-Provisioning-Token header the server returns 401.
    // To (re)install, the operator regenerates the token, which returns a fresh
    // tokenized command exactly once.
    const installUrl = await this.installerScriptService.buildInstallerUrl(device.deviceCode);
    const installCommand = await this.installerScriptService.buildInstallerCommand(
      device.deviceCode,
    );

    // Build uninstall URL/command — always available
    const uninstallUrl = await this.installerScriptService.buildUninstallUrl(device.deviceCode);
    const uninstallCommand = await this.installerScriptService.buildUninstallCommand(
      device.deviceCode,
    );

    // Build update URL/command — always available
    const updateUrl = await this.installerScriptService.buildUpdateUrl(device.deviceCode);
    const updateCommand = await this.installerScriptService.buildUpdateCommand(device.deviceCode);

    return { installCommand, uninstallCommand, updateCommand, installUrl, uninstallUrl, updateUrl };
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
        deviceId: device.id,
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
        timestamp: new Date(),
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
    const commandId = payload['commandId'] as string;
    if (!commandId) {
      this.logger.warn(`Ping response without commandId from ${deviceCode}`);
      return;
    }

    const pending = this.pendingPings.get(commandId);
    if (!pending) {
      this.logger.debug(`Ping response for unknown/expired command: ${commandId}`);
      return;
    }

    if (deviceCode !== pending.deviceCode && deviceCode !== pending.deviceId) {
      this.logger.debug(
        `Ignoring ping response for ${deviceCode}; pending command ${commandId} belongs to ${pending.deviceCode}`,
      );
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
      deviceCode: pending.deviceCode,
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
      const safeReason = (reason || 'User requested reboot')
        .replace(/[^a-zA-Z0-9 ._-]/g, '')
        .substring(0, 200);
      // Publish using tenant-scoped topic for proper ACL enforcement
      await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
        commandId: randomUUID(),
        command: 'reboot',
        reason: safeReason,
        timestamp: new Date(),
      });

      this.logger.log(`Reboot command sent to ${device.deviceCode}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send reboot to ${device.deviceCode}: ${(error as Error).message}`,
      );
      throw new BadRequestException(`Failed to send reboot command: ${(error as Error).message}`);
    }
  }

  // ==================== I/O Config Push Pipeline ====================
  //
  // Transforms cloud-side DeviceIoConfig rows into the wire format
  // expected by the Rust edge agent (sens-api-gateway/src/config.rs).
  // The agent deserialises the JSON payload directly into its
  // ModbusDeviceConfig / GpioConfig structs, so field names and
  // value semantics here MUST stay in sync with the Rust serde model.
  // ================================================================

  /**
   * Map Modbus function code (FC) to the Rust agent's register_type string.
   *
   * The Modbus standard defines four object types accessed by different
   * function codes.  The agent's ModbusRegisterConfig.register_type field
   * expects the lowercase string names used in config.rs.
   *
   * FC1 = Read Coils            -> "coil"
   * FC2 = Read Discrete Inputs  -> "discrete_input"
   * FC3 = Read Holding Regs     -> "holding"       (default / most common)
   * FC4 = Read Input Regs       -> "input"
   */
  private static mapModbusFunctionToRegisterType(fc: number | undefined): AgentRegisterType {
    switch (fc) {
      case 1:
        return 'coil';
      case 2:
        return 'discrete_input';
      case 3:
        return 'holding';
      case 4:
        return 'input';
      default:
        return 'holding'; // safe default — FC3 is the most widely used
    }
  }

  /**
   * Compute a linear scale factor from raw ↔ engineering range.
   *
   * The agent multiplies every raw register value by `scale` before
   * publishing telemetry, implementing the classic linear transform:
   *
   *   eng_value = (raw - rawMin) * scale + engMin
   *
   * where scale = (engMax - engMin) / (rawMax - rawMin).
   *
   * Returns 1.0 (identity) when ranges are missing or degenerate
   * (rawMax === rawMin) to avoid division-by-zero on the device.
   */
  private static computeLinearScale(cfg: DeviceIoConfig): number {
    const { engMax, engMin, rawMax, rawMin } = cfg;
    if (engMax == null || engMin == null || rawMax == null || rawMin == null) {
      return 1.0;
    }
    const rawSpan = Number(rawMax) - Number(rawMin);
    if (rawSpan === 0) {
      return 1.0; // degenerate range — return identity to avoid Infinity
    }
    return (Number(engMax) - Number(engMin)) / rawSpan;
  }

  /**
   * Map IoType enum to the GPIO direction string the Rust agent expects.
   *
   * The agent's GpioConfig.direction is validated against "input" | "output"
   * (see config.rs validate() — valid_directions).  Digital Inputs read
   * hardware state; Digital Outputs drive actuators.  Analog types should
   * never reach here (they use Modbus), but we defensively fall back to
   * "input" which is the safer default (read-only, no accidental actuation).
   */
  private static mapIoTypeToGpioDirection(ioType: IoType): 'input' | 'output' {
    switch (ioType) {
      case IoType.DI:
        return 'input';
      case IoType.DO:
        return 'output';
      // AI/AO should be Modbus, not GPIO — defensive fallback to read-only
      case IoType.AI:
        return 'input';
      case IoType.AO:
        return 'output';
      default:
        return 'input';
    }
  }

  /**
   * Infer the I2C driver type configuration for the Rust agent.
   *
   * Priority:
   * 1. Explicit driverType column (e.g. "atlas_ezo_ph", "generic_register")
   * 2. Well-known Atlas Scientific EZO addresses (0x61–0x66)
   * 3. Fallback: generic_direct (raw byte read)
   */
  private inferI2cDriverType(cfg: DeviceIoConfig): Record<string, unknown> {
    // If explicitly set via driverType column
    if (cfg.driverType) {
      if (cfg.driverType.startsWith('atlas_ezo_')) {
        const sensorType = cfg.driverType.replace('atlas_ezo_', '');
        return { atlas_ezo: { sensor_type: sensorType } };
      }
      if (cfg.driverType === 'generic_register') {
        return { generic_register: { read_register: 0, read_length: 4 } };
      }
      return { generic_direct: { read_length: 4 } };
    }

    // Infer from known Atlas Scientific EZO addresses
    const atlasAddressMap: Record<number, string> = {
      0x61: 'do',
      0x62: 'orp',
      0x63: 'ph',
      0x64: 'ec',
      0x66: 'temp',
    };

    const addr = cfg.i2cAddress;
    if (addr != null && atlasAddressMap[addr]) {
      return { atlas_ezo: { sensor_type: atlasAddressMap[addr] } };
    }

    // Default: generic direct read
    return { generic_direct: { read_length: 4 } };
  }

  private inferFlatI2cDriver(cfg: DeviceIoConfig): {
    driverType: string;
    sensorType: string | null;
  } {
    if (cfg.driverType?.startsWith('atlas_ezo_')) {
      return {
        driverType: 'atlas_ezo',
        sensorType: cfg.driverType.replace('atlas_ezo_', ''),
      };
    }

    if (cfg.driverType === 'generic_register') {
      return { driverType: 'generic_register', sensorType: null };
    }

    if (cfg.driverType) {
      return { driverType: cfg.driverType, sensorType: null };
    }

    const atlasAddressMap: Record<number, string> = {
      0x61: 'do',
      0x62: 'orp',
      0x63: 'ph',
      0x64: 'ec',
      0x66: 'temp',
    };
    const sensorType = cfg.i2cAddress == null ? undefined : atlasAddressMap[cfg.i2cAddress];
    return sensorType
      ? { driverType: 'atlas_ezo', sensorType }
      : { driverType: 'generic_direct', sensorType: null };
  }

  private static nullableNumber(value: number | string | null | undefined): number | null {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private static baseAgentTag(
    cfg: DeviceIoConfig,
    protocol: AgentIoTagConfig['protocol'],
  ): Omit<
    AgentIoTagConfig,
    | 'pin'
    | 'slaveId'
    | 'register'
    | 'function'
    | 'registerType'
    | 'bus'
    | 'address'
    | 'driverType'
    | 'sensorType'
  > {
    return {
      tagName: cfg.tagName,
      protocol,
      ioType: cfg.ioType,
      dataType: cfg.dataType.toLowerCase(),
      rawMin: EdgeDeviceService.nullableNumber(cfg.rawMin),
      rawMax: EdgeDeviceService.nullableNumber(cfg.rawMax),
      engMin: EdgeDeviceService.nullableNumber(cfg.engMin),
      engMax: EdgeDeviceService.nullableNumber(cfg.engMax),
      engUnit: cfg.engUnit ?? null,
      invert: cfg.invertValue ?? false,
      alarmHH: EdgeDeviceService.nullableNumber(cfg.alarmHH),
      alarmH: EdgeDeviceService.nullableNumber(cfg.alarmH),
      alarmL: EdgeDeviceService.nullableNumber(cfg.alarmL),
      alarmLL: EdgeDeviceService.nullableNumber(cfg.alarmLL),
      deadband: EdgeDeviceService.nullableNumber(cfg.deadband),
    };
  }

  private static supportedProtocolMarkers(cfg: DeviceIoConfig): AgentIoTagConfig['protocol'][] {
    const protocols: AgentIoTagConfig['protocol'][] = [];
    if (cfg.gpioPin != null) protocols.push('gpio');
    if (cfg.modbusRegister != null) protocols.push('modbus');
    if (cfg.busType === 'i2c' && cfg.i2cAddress != null) protocols.push('i2c');
    return protocols;
  }

  /**
   * Transform DeviceIoConfig rows into the agent's schemaVersion-2 flat
   * tag wire format (tools/gates/fixtures/agent-io-config-v2.golden.json
   * is the wire SSoT).
   *
   * v2 carries per-tag protocol fields (slaveId/register/function for
   * modbus, pin for gpio, bus/address for i2c). The v1 device-level
   * ModbusDeviceConfig blocks — and with them the cloud-supplied Modbus
   * TCP target IP — were retired: the agent resolves its own Modbus
   * connection target from local provisioning, so the cloud no longer
   * ships an IP it can only know stale (last heartbeat).
   *
   * @param ioConfigs  Active I/O config rows from the database
   */
  transformIoConfigsToAgentFormat(ioConfigs: DeviceIoConfig[]): AgentIoConfig {
    const tags: AgentIoTagConfig[] = [];
    const validationErrors: string[] = [];

    for (const cfg of ioConfigs) {
      const protocols = EdgeDeviceService.supportedProtocolMarkers(cfg);
      if (protocols.length === 0) {
        validationErrors.push(`${cfg.tagName}: no supported protocol address configured`);
        continue;
      }
      if (protocols.length > 1) {
        validationErrors.push(`${cfg.tagName}: multiple protocol addresses configured`);
        continue;
      }

      const protocol = protocols[0];
      if (protocol === 'gpio') {
        const gpioCfg = cfg as DeviceIoConfigWithGpioPin;
        tags.push({
          ...EdgeDeviceService.baseAgentTag(gpioCfg, 'gpio'),
          pin: gpioCfg.gpioPin,
        });
      } else if (protocol === 'modbus') {
        const modbusCfg = cfg as DeviceIoConfigWithModbusRegister;
        const modbusFunction = modbusCfg.modbusFunction ?? 3;
        tags.push({
          ...EdgeDeviceService.baseAgentTag(modbusCfg, 'modbus'),
          slaveId: modbusCfg.modbusSlaveId ?? 1,
          register: modbusCfg.modbusRegister,
          function: modbusFunction,
          registerType: EdgeDeviceService.mapModbusFunctionToRegisterType(modbusFunction),
        });
      } else {
        const i2cCfg = cfg as DeviceIoConfigWithI2cAddress;
        const driver = this.inferFlatI2cDriver(i2cCfg);
        tags.push({
          ...EdgeDeviceService.baseAgentTag(i2cCfg, 'i2c'),
          bus: i2cCfg.i2cBus ?? 1,
          address: i2cCfg.i2cAddress,
          driverType: driver.driverType,
          sensorType: driver.sensorType,
        });
      }
    }

    if (validationErrors.length > 0) {
      throw new BadRequestException(
        `I/O config semantic validation failed: ${validationErrors.join('; ')}`,
      );
    }

    return { schemaVersion: 2, tags };
  }

  /**
   * Push the full I/O configuration to a device via MQTT.
   *
   * Loads all active ioConfigs from the DB, transforms them to the agent
   * wire format, and publishes an `update_io_config` command to the
   * device's MQTT command topic.  The agent will apply the config and
   * respond with a config_ack on the responses topic (handled in
   * mqtt-listener.service.ts → handleEdgeResponse).
   *
   * We always push the COMPLETE config set (not a diff) so the agent
   * can do a full reconciliation — this avoids subtle drift issues
   * that can occur with incremental config updates in industrial systems.
   */
  async pushIoConfigToDevice(
    deviceId: string,
    tenantId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const device = await this.findByIdOrFail(deviceId, tenantId);
    const mqtt = this.ensureMqttAvailable();

    // Refuse to push config to an offline device — the MQTT message
    // would be queued (QoS 1) but the device may come back with stale
    // config.  Operators should push config after confirming connectivity.
    if (!device.isOnline) {
      return { success: false, error: 'Device is offline' };
    }

    const ioConfigs = await this.ioConfigRepository.find({
      where: { deviceId, isActive: true },
    });

    try {
      const agentConfig = this.transformIoConfigsToAgentFormat(ioConfigs);

      // LoRaWAN config'i ayrı tablodan al ve merge et
      const loraConfig = await this.buildLoRaWanConfig(deviceId);
      if (loraConfig) {
        agentConfig.lorawan = loraConfig;
      }

      const commandId = randomUUID();
      // Publish to the tenant-scoped command topic.
      // Uses device.id (UUID) — the edge agent resolves topics via device_id.
      await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
        commandId,
        command: 'update_io_config',
        params: agentConfig,
        timestamp: new Date(),
      });

      // LoRa config push (ayrı komut) — agent LoRa cihaz listesini bağımsız olarak günceller
      if (agentConfig.lorawan && agentConfig.lorawan.devices.length > 0) {
        const loraCommand = {
          commandId: randomUUID(),
          command: 'update_lora_devices',
          params: { devices: agentConfig.lorawan.devices },
          timestamp: new Date(),
        };
        await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, loraCommand);
      }

      const loraCount = loraConfig?.devices.length ?? 0;
      const countByProtocol = agentConfig.tags.reduce(
        (counts, tag) => {
          counts[tag.protocol] += 1;
          return counts;
        },
        { gpio: 0, modbus: 0, i2c: 0 },
      );
      this.logger.log(
        `Pushed I/O config to ${device.deviceCode}: ${ioConfigs.length} tags ` +
          `(${countByProtocol.modbus} modbus tags, ${countByProtocol.gpio} gpio tags, ` +
          `${countByProtocol.i2c} i2c tags, ${loraCount} lora devices)`,
      );

      return { success: true };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to push I/O config to ${device.deviceCode}: ${msg}`);
      return { success: false, error: msg };
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
    const BLOCKED_KEYS = [
      'mqtt_credentials',
      'mqtt_password',
      'firmware_update_url',
      'api_key',
      'secret',
    ];
    const configKeys = Object.keys(config);
    for (const key of configKeys) {
      if (BLOCKED_KEYS.some((blocked) => key.toLowerCase().includes(blocked))) {
        throw new BadRequestException(`Config key "${key}" is not allowed via this endpoint`);
      }
    }

    try {
      // Publish using tenant-scoped topic for proper ACL enforcement
      await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
        commandId: randomUUID(),
        command: 'config',
        config,
        timestamp: new Date(),
      });

      this.logger.log(`Config update sent to ${device.deviceCode}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send config to ${device.deviceCode}: ${(error as Error).message}`,
      );
      throw new BadRequestException(`Failed to send config: ${(error as Error).message}`);
    }
  }

  // ==================== Digital Output Control ====================
  //
  // Process editor'dan DO (Digital Output) tag'ini ON/OFF yapmak için.
  // Güvenlik kontrolleri:
  //   1. Device var mı ve online mı?
  //   2. IoConfig gerçekten DO tipinde mi?
  //   3. MQTT bağlantısı aktif mi?
  // Edge agent, set_output komutunu alıp fiziksel GPIO/Modbus çıkışını değiştirir.
  // ================================================================

  /**
   * Set a digital output value on an edge device
   * Frontend'den DO kontrolü: ON/OFF toggle
   *
   * @param deviceId   - Edge device UUID
   * @param ioConfigId - DeviceIoConfig UUID (DO tipinde olmalı)
   * @param value      - true = ON, false = OFF
   * @param tenantId   - Tenant izolasyonu için
   */
  async setDigitalOutput(
    deviceId: string,
    ioConfigId: string,
    value: boolean,
    tenantId: string,
    userId?: string,
  ): Promise<{ success: boolean; error?: string; tagName?: string; value?: boolean }> {
    // 1. Device'ı bul ve tenant sınırını kontrol et
    const device = await this.findByIdOrFail(deviceId, tenantId);

    // 2. Decommissioned device kontrolü — artık kullanılmayan cihaza komut gönderilmemeli
    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      return { success: false, error: 'Device is decommissioned — cannot send output command' };
    }

    // 3. Device online kontrolü — offline cihaza komut göndermek anlamsız
    if (!device.isOnline) {
      return { success: false, error: 'Device is offline — cannot send output command' };
    }

    // 4. I/O config'i bul ve DO tipi olduğunu doğrula
    const ioConfig = await this.ioConfigRepository.findOne({
      where: { id: ioConfigId, deviceId },
    });

    if (!ioConfig) {
      return { success: false, error: `I/O config '${ioConfigId}' not found on device` };
    }

    // Sadece DO (Digital Output) tipine izin ver — güvenlik katmanı
    if (ioConfig.ioType !== IoType.DO) {
      return {
        success: false,
        error: `Tag '${ioConfig.tagName}' is type '${ioConfig.ioType}', not DO. Only DO tags can be toggled.`,
      };
    }

    // 5. MQTT bağlantısını kontrol et — diğer mutation'larla tutarlı soft-fail pattern
    //    ensureMqttAvailable() BadRequestException fırlatır, burada yakalayıp
    //    { success: false } döndürüyoruz ki frontend tutarlı hata yönetimi yapabilsin.
    let mqtt: MqttClientService;
    try {
      mqtt = this.ensureMqttAvailable();
    } catch {
      return { success: false, error: 'MQTT service not available — cannot send command' };
    }

    const commandId = randomUUID();

    try {
      // 6. Edge agent'a set_output komutu gönder
      // Topic: tenants/{tenantId}/devices/{device.id}/commands
      // Agent bu komutu alıp GPIO/Modbus üzerinden fiziksel çıkışı değiştirir
      await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
        commandId,
        command: 'set_output',
        params: {
          tag_name: ioConfig.tagName,
          value,
          // Agent'ın hangi pini/register'ı kullanacağını bilmesi için
          gpio_pin: ioConfig.gpioPin,
          modbus_register: ioConfig.modbusRegister,
          modbus_slave_id: ioConfig.modbusSlaveId,
          io_type: ioConfig.ioType,
          // invertValue: I/O config'de ters çevrilme ayarı varsa agent bunu uygular
          // Ör: NO (Normally Open) röle durumlarında fiziksel çıkışı ters çevirmek gerekir
          invert_value: ioConfig.invertValue ?? false,
        },
        timestamp: new Date(),
        // Audit trail — hangi kullanıcı bu komutu tetikledi
        ...(userId ? { triggeredBy: userId } : {}),
      });

      this.logger.log(
        `DO command sent: ${ioConfig.tagName} = ${value} on ${device.deviceCode} (command: ${commandId}, user: ${userId || 'system'})`,
      );

      return { success: true, tagName: ioConfig.tagName, value };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to send DO command to ${device.deviceCode}: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // ==================== I/O Auto-Detection (v2.3) ====================

  /**
   * Pending hardware scan requests — mirrors the ping promise pattern.
   * Each entry is keyed by commandId and resolves when the agent responds.
   */
  private readonly pendingScans: Map<string, PendingScan> = new Map();
  private readonly SCAN_TIMEOUT_MS = 15000; // 15s — scanning takes longer than ping

  /**
   * Send `scan_hardware` command to the edge agent and await response.
   *
   * Uses the same promise-based pattern as `pingDevice()`:
   * 1. Create promise + timeout
   * 2. Publish MQTT command
   * 3. Response handler resolves the promise
   *
   * The agent performs platform-specific enumeration:
   * - RevPi: piControl process image (piTest -d)
   * - RPi: BCM GPIO 2-27
   * - Generic: /sys/class/gpio/gpiochip*
   */
  async scanHardware(deviceId: string, tenantId: string): Promise<HardwareScanResult> {
    const device = await this.findByIdOrFail(deviceId, tenantId);

    // Only scan active/maintenance devices
    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      return {
        success: false,
        error: 'Device is decommissioned',
        platform: 'Unknown',
        discoveredChannels: [],
        totalFound: 0,
      };
    }

    if (!device.isOnline) {
      return {
        success: false,
        error: 'Device is offline — cannot perform hardware scan',
        platform: 'Unknown',
        discoveredChannels: [],
        totalFound: 0,
      };
    }

    // Soft-fail MQTT check
    let mqtt: MqttClientService;
    try {
      mqtt = this.ensureMqttAvailable();
    } catch {
      return {
        success: false,
        error: 'MQTT service not available',
        platform: 'Unknown',
        discoveredChannels: [],
        totalFound: 0,
      };
    }

    const commandId = randomUUID();
    const startTime = Date.now();

    // Create promise that resolves on agent response or timeout
    const scanPromise = new Promise<HardwareScanResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingScans.delete(commandId);
        resolve({
          success: false,
          error: 'Scan timeout — device did not respond within 15 seconds',
          platform: 'Unknown',
          discoveredChannels: [],
          totalFound: 0,
        });
      }, this.SCAN_TIMEOUT_MS);

      this.pendingScans.set(commandId, {
        commandId,
        deviceCode: device.deviceCode,
        deviceId: device.id,
        startTime,
        resolve,
        timeout,
      });
    });

    // Send scan_hardware command via tenant-scoped topic
    try {
      await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
        commandId,
        command: 'scan_hardware',
        timestamp: new Date(),
      });
      this.logger.log(`scan_hardware command sent to ${device.deviceCode} (${commandId})`);
    } catch (error) {
      const pending = this.pendingScans.get(commandId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingScans.delete(commandId);
      }
      return {
        success: false,
        error: `Failed to send scan command: ${(error as Error).message}`,
        platform: 'Unknown',
        discoveredChannels: [],
        totalFound: 0,
      };
    }

    return scanPromise;
  }

  /**
   * Handle scan_hardware response from edge agent.
   * Called by MqttListenerService when command='scan_hardware' response arrives.
   */
  handleScanHardwareResponse(deviceCode: string, payload: Record<string, unknown>): void {
    const commandId = payload['commandId'] as string;
    if (!commandId) {
      this.logger.warn(`Scan response without commandId from ${deviceCode}`);
      return;
    }

    const pending = this.pendingScans.get(commandId);
    if (!pending) {
      this.logger.debug(`Scan response for unknown/expired command: ${commandId}`);
      return;
    }

    // Validate device identifier matches pending request (defense-in-depth)
    // The identifier from MQTT topic can be either deviceCode or device UUID
    if (pending.deviceCode !== deviceCode && pending.deviceId !== deviceCode) {
      this.logger.warn(
        `Scan response device mismatch: expected=${pending.deviceCode}/${pending.deviceId}, got=${deviceCode}, commandId=${commandId}`,
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingScans.delete(commandId);

    const elapsed = Date.now() - pending.startTime;
    this.logger.log(`Scan response from ${deviceCode} in ${elapsed}ms`);

    // Extract result from agent response
    const result = (payload['result'] ?? payload['data'] ?? payload) as Record<string, unknown>;
    const success = (payload['success'] as boolean) ?? true;

    if (!success) {
      pending.resolve({
        success: false,
        error: (payload['error'] as string) ?? 'Scan failed on device',
        platform: 'Unknown',
        discoveredChannels: [],
        totalFound: 0,
      });
      return;
    }

    // Map agent's DiscoveredIo[] to backend DTO
    const discoveredIos = (result['discovered_ios'] as Array<Record<string, unknown>>) ?? [];
    const discoveredChannels = discoveredIos.map((io) => ({
      tagName: (io['tag_name'] as string) ?? '',
      ioType: (io['io_type'] as string) ?? 'DI',
      dataType: (io['data_type'] as string) ?? 'BOOL',
      moduleAddress: (io['module_address'] as number) ?? 0,
      channel: (io['channel'] as number) ?? 0,
      description: (io['description'] as string) ?? '',
      gpioPin: (io['gpio_pin'] as number | undefined) ?? undefined,
      source: (io['source'] as string) ?? 'unknown',
      busType: (io['bus_type'] as string | undefined) ?? undefined,
      i2cBus: (io['i2c_bus'] as number | undefined) ?? undefined,
      i2cAddress: (io['i2c_address'] as number | undefined) ?? undefined,
      i2cDeviceName: (io['i2c_device_name'] as string | undefined) ?? undefined,
      spiBus: (io['spi_bus'] as number | undefined) ?? undefined,
      spiCs: (io['spi_cs'] as number | undefined) ?? undefined,
      uartPort: (io['uart_port'] as string | undefined) ?? undefined,
    }));

    // Map I2C bus info
    const i2cBuses = ((result['i2c_buses'] as Array<Record<string, unknown>>) ?? []).map((bus) => ({
      bus: (bus['bus'] as number) ?? 0,
      deviceCount: (bus['device_count'] as number) ?? 0,
      devices: ((bus['devices'] as Array<Record<string, unknown>>) ?? []).map((dev) => ({
        address: (dev['address'] as number) ?? 0,
        addressHex: (dev['address_hex'] as string) ?? '0x00',
        deviceName: (dev['device_name'] as string | undefined) ?? undefined,
        deviceDescription: (dev['device_description'] as string | undefined) ?? undefined,
      })),
    }));

    // Map SPI bus info
    const spiBuses = ((result['spi_buses'] as Array<Record<string, unknown>>) ?? []).map((spi) => ({
      devicePath: (spi['device_path'] as string) ?? '',
      bus: (spi['bus'] as number) ?? 0,
      chipSelect: (spi['chip_select'] as number) ?? 0,
    }));

    // Map UART port info
    const uartPorts = ((result['uart_ports'] as Array<Record<string, unknown>>) ?? []).map(
      (uart) => ({
        devicePath: (uart['device_path'] as string) ?? '',
        portType: (uart['port_type'] as string) ?? 'unknown',
      }),
    );

    pending.resolve({
      success: true,
      platform: (result['platform'] as string) ?? 'Unknown',
      discoveredChannels,
      totalFound: discoveredChannels.length,
      i2cBuses: i2cBuses.length > 0 ? i2cBuses : undefined,
      spiBuses: spiBuses.length > 0 ? spiBuses : undefined,
      uartPorts: uartPorts.length > 0 ? uartPorts : undefined,
    });
  }

  /**
   * Bulk add I/O configurations to a device.
   *
   * Skips channels whose tagName already exists on the device (no duplicates).
   * Returns both created configs and skipped tag names for user feedback.
   */
  async bulkAddIoConfigs(
    deviceId: string,
    tenantId: string,
    inputs: AddIoConfigInput[],
  ): Promise<{
    created: DeviceIoConfig[];
    skipped: string[];
    createdCount: number;
    skippedCount: number;
  }> {
    const device = await this.findByIdOrFail(deviceId, tenantId);

    // Load existing tags for duplicate detection
    const existingConfigs = await this.ioConfigRepository.find({
      where: { deviceId: device.id },
      select: ['tagName'],
    });
    const existingTags = new Set(existingConfigs.map((c) => c.tagName));

    const skipped: string[] = [];
    const toCreate: AddIoConfigInput[] = [];

    for (const input of inputs) {
      if (existingTags.has(input.tagName)) {
        skipped.push(input.tagName);
      } else {
        toCreate.push(input);
        existingTags.add(input.tagName); // Prevent duplicates within the batch
      }
    }

    // Use transaction for atomicity — all or nothing
    const created = await this.dataSource.transaction(async (manager) => {
      // DeviceIoConfig has NO tenantId column — its tenant scoping is
      // inherited from the parent EdgeDevice row (authenticated via
      // device.id above). Wrapping with tenantManagerRepo() would
      // inject a nonexistent tenantId column and fail at INSERT time.
      // See orphan finding ORPHAN-DIC-001 for the architectural
      // question (should DeviceIoConfig gain a tenantId column?).
      // eslint-disable-next-line no-restricted-syntax -- ORPHAN-DIC-001
      const ioConfigRepo = manager.getRepository(DeviceIoConfig);
      const results: DeviceIoConfig[] = [];

      for (const input of toCreate) {
        const ioConfig = ioConfigRepo.create({
          id: randomUUID(),
          deviceId: device.id,
          tagName: input.tagName,
          description: input.description,
          ioType: input.ioType,
          dataType: input.dataType,
          moduleAddress: input.moduleAddress,
          channel: input.channel,
          rawMin: input.rawMin,
          rawMax: input.rawMax,
          engMin: input.engMin,
          engMax: input.engMax,
          engUnit: input.engUnit,
          modbusFunction: input.modbusFunction,
          modbusSlaveId: input.modbusSlaveId,
          modbusRegister: input.modbusRegister,
          gpioPin: input.gpioPin,
          gpioMode: input.gpioMode,
          busType: input.busType,
          i2cBus: input.i2cBus,
          i2cAddress: input.i2cAddress,
          spiBus: input.spiBus,
          spiCs: input.spiCs,
          uartPort: input.uartPort,
          driverType: input.driverType,
          invertValue: input.invertValue,
          alarmHH: input.alarmHH,
          alarmH: input.alarmH,
          alarmL: input.alarmL,
          alarmLL: input.alarmLL,
          deadband: input.deadband,
          isActive: true,
        });

        const saved = await ioConfigRepo.save(ioConfig);
        results.push(saved);
      }

      return results;
    });

    this.logger.log(
      `Bulk I/O import on ${device.deviceCode}: ${created.length} created, ${skipped.length} skipped`,
    );

    return {
      created,
      skipped,
      createdCount: created.length,
      skippedCount: skipped.length,
    };
  }

  // ==================== LoRaWAN Device Management ====================
  //
  // Edge device'a bağlı LoRa end-device'ların CRUD operasyonları.
  // Her LoRa cihazı, SX1302 concentrator HAT takılı bir Raspberry Pi
  // (EdgeDevice) üzerinden yönetilir. Agent, bu cihazların join ve
  // uplink/downlink işlemlerini otomatik olarak gerçekleştirir.
  // ================================================================

  /**
   * Build LoRaWAN config section for the agent wire format.
   *
   * EdgeDevice'a bağlı tüm LoRa cihazları sorgulanır ve Rust agent'ın
   * beklediği snake_case formatına dönüştürülür. Cihaz yoksa null döner
   * (agent LoRa modülünü başlatmaz).
   */
  async buildLoRaWanConfig(edgeDeviceId: string): Promise<AgentLoRaWanConfig | null> {
    const loraDevices = await this.loraDeviceRepository.find({
      where: { edgeDeviceId },
    });

    if (loraDevices.length === 0) {
      return null;
    }

    return {
      enabled: true,
      devices: loraDevices.map(
        (dev): AgentLoRaDeviceConfig => ({
          dev_eui: dev.devEui,
          // Rust String bekler, null olmaz — varsayılan sıfır EUI kullan
          app_eui: dev.appEui ?? '0000000000000000',
          app_key: dev.appKey,
          dev_addr: dev.devAddr ?? null,
          // Rust serde küçük harf bekler: "otaa" | "abp"
          activation: dev.activationMode.toLowerCase(),
          // Rust serde küçük harf bekler: "a" | "b" | "c"
          device_class: dev.deviceClass.toLowerCase(),
          name: dev.name,
          tag_prefix: dev.tagPrefix,
          codec: dev.codec,
          adr_enabled: dev.adrEnabled,
          f_port: dev.fPort,
        }),
      ),
    };
  }

  /**
   * Get all LoRa devices for an edge device.
   */
  async getLoRaDevices(edgeDeviceId: string, tenantId: string): Promise<LoRaDevice[]> {
    // Tenant boundary check
    await this.findByIdOrFail(edgeDeviceId, tenantId);

    return await this.loraDeviceRepository.find({
      where: { edgeDeviceId, tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Add a LoRa end-device to an edge gateway.
   *
   * DevEUI uniqueness DB seviyesinde unique index ile korunur.
   * Aynı DevEUI ile ikinci kayıt ConflictException fırlatır.
   */
  async addLoRaDevice(
    edgeDeviceId: string,
    tenantId: string,
    input: {
      devEui: string;
      appEui?: string;
      appKey: string;
      name: string;
      tagPrefix: string;
      activationMode?: LoRaActivationMode;
      deviceClass?: LoRaDeviceClass;
      codec?: string;
      adrEnabled?: boolean;
    },
  ): Promise<LoRaDevice> {
    // Verify edge device exists and belongs to tenant
    await this.findByIdOrFail(edgeDeviceId, tenantId);

    // Check DevEUI uniqueness
    const existing = await this.loraDeviceRepository.findOne({
      where: { devEui: input.devEui.toUpperCase() },
    });
    if (existing) {
      throw new ConflictException(`LoRa device with DevEUI '${input.devEui}' already exists`);
    }

    const device = this.loraDeviceRepository.create({
      edgeDeviceId,
      tenantId,
      devEui: input.devEui.toUpperCase(),
      appEui: input.appEui?.toUpperCase(),
      appKey: input.appKey.toUpperCase(),
      name: input.name,
      tagPrefix: input.tagPrefix,
      activationMode: input.activationMode ?? LoRaActivationMode.OTAA,
      deviceClass: input.deviceClass ?? LoRaDeviceClass.A,
      codec: input.codec ?? 'cayenne_lpp',
      adrEnabled: input.adrEnabled ?? true,
      fPort: 1,
      isJoined: false,
    });

    const saved = await this.loraDeviceRepository.save(device);
    this.logger.log(
      `Added LoRa device: ${saved.name} (DevEUI: ${saved.devEui}) to edge ${edgeDeviceId}`,
    );

    // Ekleme sonrası agent'a güncel LoRa config gönder
    const edgeDevice = await this.deviceRepository.findOne({ where: { id: edgeDeviceId } });
    if (edgeDevice) {
      await this.pushLoRaConfigToDevice(edgeDevice);
    }

    return saved;
  }

  /**
   * Remove a LoRa device by ID.
   * Tenant boundary check yapılır — farklı tenant'ın cihazı silinemez.
   */
  async removeLoRaDevice(edgeDeviceId: string, id: string, tenantId: string): Promise<boolean> {
    const device = await this.loraDeviceRepository.findOne({
      where: { id, tenantId },
    });
    if (!device) {
      throw new NotFoundException(`LoRa device with ID '${id}' not found`);
    }

    await this.loraDeviceRepository.delete({ id });
    this.logger.log(`Removed LoRa device: ${device.name} (DevEUI: ${device.devEui})`);

    // Silme sonrası agent'a güncel LoRa config gönder
    const edgeDevice = await this.deviceRepository.findOne({ where: { id: edgeDeviceId } });
    if (edgeDevice) {
      await this.pushLoRaConfigToDevice(edgeDevice);
    }

    return true;
  }

  /**
   * Sadece LoRa config'ini agent'a push et.
   * addLoRaDevice ve removeLoRaDevice sonrası çağrılır —
   * agent'ın LoRa cihaz listesini güncel tutmak için.
   * Device offline ise sessizce atlanır (log ile bildirilir).
   */
  private async pushLoRaConfigToDevice(edgeDevice: EdgeDevice): Promise<void> {
    if (!edgeDevice.isOnline) {
      this.logger.debug(
        `Skipping LoRa config push to ${edgeDevice.deviceCode} — device is offline`,
      );
      return;
    }

    let mqtt: MqttClientService;
    try {
      mqtt = this.ensureMqttAvailable();
    } catch {
      this.logger.warn('MQTT not available — skipping LoRa config push');
      return;
    }

    const loraConfig = await this.buildLoRaWanConfig(edgeDevice.id);

    // Cihaz listesi boşsa agent'a LoRa modülünü kapatması için boş liste gönder
    const devices = loraConfig?.devices ?? [];

    try {
      await mqtt.publish(`tenants/${edgeDevice.tenantId}/devices/${edgeDevice.id}/commands`, {
        commandId: randomUUID(),
        command: 'update_lora_devices',
        params: { devices },
        timestamp: new Date(),
      });
      this.logger.log(`Pushed LoRa config to ${edgeDevice.deviceCode}: ${devices.length} devices`);
    } catch (error) {
      this.logger.error(
        `Failed to push LoRa config to ${edgeDevice.deviceCode}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Send a downlink payload to a LoRa end-device via MQTT.
   *
   * Edge agent, MQTT command topic'inden gelen downlink komutunu alır
   * ve SX1302 üzerinden ilgili cihazın bir sonraki RX window'unda
   * payload'ı iletir. Class A cihazlarda bu bir sonraki uplink'i
   * bekler; Class C cihazlarda hemen gönderilir.
   *
   * @param edgeDeviceId  Edge device (gateway) UUID
   * @param loraDeviceId  LoRa device UUID
   * @param payload       Hex string downlink payload
   * @param fPort         Application port (1-223)
   * @param tenantId      Tenant isolation
   * @param confirmed     Confirmed downlink — cihazdan ACK beklenir mi
   */
  async sendLoRaDownlink(
    edgeDeviceId: string,
    loraDeviceId: string,
    payload: string,
    fPort: number,
    tenantId: string,
    confirmed = false,
  ): Promise<{ success: boolean; error?: string }> {
    const loraDevice = await this.loraDeviceRepository.findOne({
      where: { id: loraDeviceId, tenantId },
    });
    if (!loraDevice) {
      return { success: false, error: `LoRa device '${loraDeviceId}' not found` };
    }

    // DevAddr null kontrolü — join olmamış cihaza downlink gönderilemez
    if (!loraDevice.devAddr) {
      return {
        success: false,
        error:
          `LoRa device '${loraDevice.name}' has not joined the network yet (devAddr is null). ` +
          `Wait for join_accept before sending downlink.`,
      };
    }

    // Edge device'ı bul — MQTT topic için gerekli
    const edgeDevice = await this.deviceRepository.findOne({
      where: { id: edgeDeviceId, tenantId },
    });
    if (!edgeDevice) {
      return { success: false, error: 'Parent edge device not found' };
    }

    if (!edgeDevice.isOnline) {
      return { success: false, error: 'Edge device is offline' };
    }

    let mqtt: MqttClientService;
    try {
      mqtt = this.ensureMqttAvailable();
    } catch {
      return { success: false, error: 'MQTT service not available' };
    }

    const commandId = randomUUID();

    try {
      await mqtt.publish(`tenants/${edgeDevice.tenantId}/devices/${edgeDevice.id}/commands`, {
        commandId,
        command: 'lora_downlink',
        params: {
          dev_addr: loraDevice.devAddr, // dev_eui DEĞİL — LoRa downlink devAddr üzerinden çalışır
          payload, // hex string olarak (frontend'ten gelen hex doğrudan iletilir)
          f_port: fPort,
          confirmed,
        },
        timestamp: new Date(),
      });

      this.logger.log(
        `LoRa downlink sent to ${loraDevice.name} (DevAddr: ${loraDevice.devAddr}) ` +
          `via ${edgeDevice.deviceCode} (fPort: ${fPort}, confirmed: ${confirmed})`,
      );
      return { success: true };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to send LoRa downlink: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // ==================== Firmware Update Methods ====================

  /**
   * Firmware versions are sourced from the signed Edge release registry.
   * Until that registry is wired into this service, production must not infer
   * consumable versions from live GitHub release state.
   */
  getAvailableFirmwareVersions(): FirmwareVersionInfo[] {
    this.logger.warn(
      'Edge release registry is not connected to availableFirmwareVersions; returning no production-consumable firmware versions.',
    );
    return [];
  }

  /**
   * Legacy firmware update path. Production rollouts use the signed release
   * registry and apply_signed_manifest command path, not live latest tarballs.
   */
  async updateDeviceFirmware(
    deviceId: string,
    tenantId: string,
    targetVersion?: string,
  ): Promise<EdgeDevice> {
    if (!this.isLegacyOtaAllowed()) {
      throw new BadRequestException(
        'Legacy update_firmware is disabled. Use the signed Edge release registry and apply_signed_manifest rollout path.',
      );
    }

    if (!targetVersion || targetVersion === 'latest') {
      throw new BadRequestException(
        'Firmware update requires an explicit agent-v<exact Cargo semver> target version.',
      );
    }

    if (!/^agent-v\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(targetVersion)) {
      throw new BadRequestException(
        `Invalid firmware version format: '${targetVersion}'. Expected agent-v<exact Cargo semver>.`,
      );
    }

    const device = await this.findByIdOrFail(deviceId, tenantId);

    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      throw new BadRequestException('Cannot update firmware on decommissioned device');
    }

    // Send MQTT command first — only persist targetFirmwareVersion if
    // the command was successfully published. This prevents the DB from
    // recording a pending update that was never actually sent.
    const mqtt = this.ensureMqttAvailable();

    await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {
      commandId: randomUUID(),
      command: 'update_firmware',
      params: {
        target_version: targetVersion,
      },
      timestamp: new Date(),
    });

    // Persist after successful MQTT publish
    device.targetFirmwareVersion = targetVersion;
    const saved = await this.deviceRepository.save(device);

    this.logger.log(
      `Legacy firmware update command sent to ${device.deviceCode}: target=${targetVersion}`,
    );

    return saved;
  }

  /**
   * Trigger firmware update on multiple edge devices.
   * Collects results without throwing on individual failures.
   */
  async bulkUpdateDeviceFirmware(
    deviceIds: string[],
    tenantId: string,
    targetVersion?: string,
  ): Promise<{ success: string[]; failed: { id: string; error: string }[] }> {
    const success: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const deviceId of deviceIds) {
      try {
        await this.updateDeviceFirmware(deviceId, tenantId, targetVersion);
        success.push(deviceId);
      } catch (error) {
        failed.push({ id: deviceId, error: (error as Error).message });
      }
    }

    this.logger.log(`Bulk firmware update: ${success.length} succeeded, ${failed.length} failed`);

    return { success, failed };
  }

  /**
   * Update LoRa device runtime status from MQTT lora_events.
   *
   * Edge agent, join_accept ve uplink_summary event'lerini publish eder.
   * Bu metod ilgili LoRa cihazının durum alanlarını günceller.
   */
  async updateLoRaDeviceStatus(
    devEui: string,
    update: {
      isJoined?: boolean;
      joinedAt?: Date;
      lastSeenAt?: Date;
      lastRssi?: number;
      lastSnr?: number;
      frameCountUp?: number;
      devAddr?: string;
    },
  ): Promise<void> {
    const device = await this.loraDeviceRepository.findOne({
      where: { devEui: devEui.toUpperCase() },
    });
    if (!device) {
      this.logger.warn(`LoRa event for unknown DevEUI: ${devEui}`);
      return;
    }

    if (update.isJoined !== undefined) device.isJoined = update.isJoined;
    if (update.joinedAt) device.joinedAt = update.joinedAt;
    if (update.lastSeenAt) device.lastSeenAt = update.lastSeenAt;
    if (update.lastRssi !== undefined) device.lastRssi = update.lastRssi;
    if (update.lastSnr !== undefined) device.lastSnr = update.lastSnr;
    if (update.frameCountUp !== undefined) device.frameCountUp = update.frameCountUp;
    if (update.devAddr) device.devAddr = update.devAddr;

    await this.loraDeviceRepository.save(device);
  }

  // ==================== Tenant Schema Helpers ====================
  // getTenantSchemaFromId() consolidated into backend-common getTenantSchemaName().
  // Using the shared util eliminates drift between edge-device.service.ts,
  // provisioning.service.ts, and SchemaManagerService.

  private getTenantSchemaFromId(tenantId: string): string {
    return getTenantSchemaName(tenantId);
  }

  private rowString(row: RowValueMap, key: string): string | undefined {
    const value = row[key];
    return typeof value === 'string' ? value : undefined;
  }

  private rowNumber(row: RowValueMap, key: string): number | undefined {
    const value = row[key];
    return typeof value === 'number' ? value : undefined;
  }

  private rowBoolean(row: RowValueMap, key: string): boolean {
    const value = row[key];
    return typeof value === 'boolean' ? value : false;
  }

  private rowDate(row: RowValueMap, key: string): Date | undefined {
    const value = row[key];
    if (value instanceof Date) {
      return value;
    }
    return typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
  }

  private rowObject(row: RowValueMap, key: string): Record<string, unknown> | undefined {
    const value = row[key];
    return EdgeDeviceService.isRecord(value) ? value : undefined;
  }

  private rowFingerprint(row: RowValueMap): EdgeDeviceFingerprint | null {
    const value = this.rowObject(row, 'fingerprint');
    if (!value) {
      return null;
    }
    return {
      cpuSerial: this.stringOrUndefined(value.cpuSerial),
      macAddresses: Array.isArray(value.macAddresses)
        ? value.macAddresses.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
      machineId: this.stringOrUndefined(value.machineId),
      hostname: this.stringOrUndefined(value.hostname),
    };
  }

  private stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private mapRowToEdgeDevice(row: RowValueMap): EdgeDevice {
    const device = new EdgeDevice();
    device.id = this.rowString(row, 'id') ?? '';
    device.tenantId = this.rowString(row, 'tenant_id') ?? '';
    device.deviceCode = this.rowString(row, 'device_code') ?? '';
    device.deviceName = this.rowString(row, 'device_name') ?? '';
    device.deviceModel =
      (this.rowString(row, 'device_model') as DeviceModel | undefined) ?? DeviceModel.CUSTOM;
    device.serialNumber = this.rowString(row, 'serial_number');
    device.description = this.rowString(row, 'description');
    device.siteId = this.rowString(row, 'site_id');
    device.lifecycleState =
      (this.rowString(row, 'lifecycle_state') as DeviceLifecycleState | undefined) ??
      DeviceLifecycleState.REGISTERED;
    device.mqttClientId = this.rowString(row, 'mqtt_client_id');
    device.mqttPasswordHash = this.rowString(row, 'mqtt_password_hash') ?? null;
    device.isOnline = this.rowBoolean(row, 'is_online');
    device.lastSeenAt = this.rowDate(row, 'last_seen_at');
    device.cpuUsage = this.rowNumber(row, 'cpu_usage');
    device.memoryUsage = this.rowNumber(row, 'memory_usage');
    device.storageUsage = this.rowNumber(row, 'storage_usage');
    device.temperatureCelsius = this.rowNumber(row, 'temperature_celsius');
    device.uptimeSeconds = this.rowNumber(row, 'uptime_seconds');
    device.firmwareVersion = this.rowString(row, 'firmware_version');
    device.targetFirmwareVersion = this.rowString(row, 'target_firmware_version');
    device.ipAddress = this.rowString(row, 'ip_address');
    device.connectionQuality = this.rowNumber(row, 'connection_quality');
    device.fingerprint = this.rowFingerprint(row);
    device.agentVersion = this.rowString(row, 'agent_version') ?? null;
    device.config = this.rowObject(row, 'config');
    return device;
  }
}

// ==================== Internal Types ====================

/**
 * Pending scan request — mirrors PendingPing pattern.
 */
interface PendingScan {
  commandId: string;
  deviceCode: string;
  deviceId: string;
  startTime: number;
  resolve: (result: HardwareScanResult) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Firmware version info from GitHub releases.
 */
export interface FirmwareVersionInfo {
  tag: string;
  name: string;
  publishedAt: Date;
  prerelease: boolean;
}

/**
 * Hardware scan result — matches the DTO returned to GraphQL.
 */
interface HardwareScanResult {
  success: boolean;
  error?: string;
  platform: string;
  discoveredChannels: Array<{
    tagName: string;
    ioType: string;
    dataType: string;
    moduleAddress: number;
    channel: number;
    description?: string;
    gpioPin?: number;
    source: string;
    busType?: string;
    i2cBus?: number;
    i2cAddress?: number;
    i2cDeviceName?: string;
    spiBus?: number;
    spiCs?: number;
    uartPort?: string;
  }>;
  totalFound: number;
  i2cBuses?: Array<{
    bus: number;
    deviceCount: number;
    devices: Array<{
      address: number;
      addressHex: string;
      deviceName?: string;
      deviceDescription?: string;
    }>;
  }>;
  spiBuses?: Array<{
    devicePath: string;
    bus: number;
    chipSelect: number;
  }>;
  uartPorts?: Array<{
    devicePath: string;
    portType: string;
  }>;
}
