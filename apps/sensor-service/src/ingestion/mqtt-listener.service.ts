import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { IEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import { Repository, DataSource, EntityManager } from 'typeorm';

/**
 * SECURITY: UUID constant for system-level operations.
 * Replaces the fragile string literal 'system' as tenantId which could
 * collide with an actual tenant named 'system'.
 * @see SENSOR-MEDIUM-003
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

import { AutomationService } from '../automation/automation.service';
import { DeploymentLogService } from '../automation/services/deployment-log.service';
import { ScadaDeployLogService } from '../process/services/scada-deploy-log.service';
import { ScadaDeployStatus } from '../process/entities/scada-deploy-log.entity';
import { ScadaPackageService } from '../process/services/scada-package.service';
import { DeployArtifactType } from '../deploy-artifact/entities/deploy-artifact.entity';
import { ReleaseBundle } from '../release-bundle/entities/release-bundle.entity';
import { ReleaseBundleService } from '../release-bundle/release-bundle.service';
import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { SensorMetricInput } from '../database/entities/sensor-metric.entity';
import { QualityCodes } from '../database/sensor-quality.authority';
import { Sensor, SensorStatus } from '../database/entities/sensor.entity';
import {
  DeviceEvent,
  DeviceEventType,
  DeviceEventSeverity,
} from '../edge-device/entities/device-event.entity';
import { DeviceIoConfig } from '../edge-device/entities/device-io-config.entity';
import { EdgeDevice } from '../edge-device/entities/edge-device.entity';
import { EdgeDeviceService, DeviceHeartbeat } from '../edge-device/edge-device.service';
import { withTenantContext } from '@aquaculture/backend-common/context';
import {
  listTenantSchemas,
  pinTenantSchemaTransactionSearchPath,
  runInTenantTransaction,
  tenantManagerRepo,
  TenantScopedRepository,
} from '@aquaculture/backend-common/database';
import { MqttClientService } from '../shared-mqtt/mqtt-client.service';
import { SensorServiceProfileService } from '../config/sensor-service-profile.service';
import { VfdEdgeProvisioningService } from '../vfd/services/vfd-edge-provisioning.service';
import { VfdEdgeReadService } from '../vfd/services/vfd-edge-read.service';
import { VfdEdgeWriteService } from '../vfd/services/vfd-edge-write.service';
import { SensorTopicCacheService, CachedSensorInfo } from './sensor-topic-cache.service';
import { SensorMetricWriterService } from './sensor-metric-writer.service';

/**
 * MQTT Topic Pattern for tenant-aware sensor data
 * Format: sensors/{tenantId}/{sensorId}/data
 * or: sensors/{tenantId}/{location}/+
 */
interface ParsedTopic {
  tenantId: string;
  sensorId?: string;
  location?: string;
}

/**
 * Edge device payload types
 */
interface EdgeHeartbeatPayload {
  isOnline?: boolean;
  status?: string;
  cpuUsage?: number;
  memoryUsage?: number;
  storageUsage?: number;
  temperatureCelsius?: number;
  uptimeSeconds?: number;
  firmwareVersion?: string;
  ipAddress?: string;
}

interface EdgeBirthPayload {
  firmwareVersion?: string;
  ipAddress?: string;
  properties?: {
    firmwareVersion?: string;
    ipAddress?: string;
  };
}

interface EdgeResponsePayload {
  command?: string;
  commandId?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Edge Agent TelemetryMetrics fields (snake_case from Rust serde)
 */
interface TelemetryMetricsFields {
  cpu_usage_percent?: number;
  cpuUsage?: number;
  memory_usage_percent?: number;
  memoryUsage?: number;
  disk_usage_percent?: number;
  storageUsage?: number;
  temperature_celsius?: number;
  temperatureCelsius?: number;
  uptime_secs?: number;
  uptimeSeconds?: number;
  agent_version?: string;
  firmwareVersion?: string;
  ip_address?: string;
  ipAddress?: string;
}

/**
 * Tenant edge telemetry payload (Edge Agent TelemetryMessage format)
 *
 * Edge agent sends: { device_id, device_code, timestamp, metrics: { cpu_usage_percent, ... } }
 * The actual metrics are NESTED under "metrics" key.
 * We also support flat format for backward compatibility.
 */
interface TenantEdgeTelemetryPayload extends TelemetryMetricsFields {
  device_id?: string;
  device_code?: string;
  timestamp?: string;
  agent_version?: string;
  metrics?: TelemetryMetricsFields;
}

/**
 * Tenant edge status payload
 */
interface TenantEdgeStatusPayload {
  online?: boolean;
  isOnline?: boolean;
  /** Edge agent sends status as string: "online" | "offline" | "maintenance" | "error" */
  status?: string;
  timestamp?: string;
  /** Edge agent includes its version in status messages */
  agent_version?: string;
  /** Edge agent includes uptime in status messages */
  uptime_seconds?: number;
}

/**
 * MQTT Listener Service
 * Global MQTT listener that subscribes to all sensor topics
 * and routes data to appropriate sensors.
 *
 * Uses MqttClientService for MQTT connection (shared with other modules).
 */
@Injectable()
export class MqttListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttListenerService.name);
  private readonly messageHandler: (topic: string, message: Buffer) => void;

  // Channel lookup cache: sensorId -> { channels, expiresAt }
  private readonly channelCache = new Map<
    string,
    { channels: SensorDataChannel[]; expiresAt: number }
  >();
  private readonly CHANNEL_CACHE_TTL_MS = 60_000; // 60 seconds

  // Cache for device lookups (tenantId:deviceCode -> device entity)
  private readonly deviceCache = new Map<string, { device: EdgeDevice; expiry: number }>();
  // Cache for io configs (deviceId -> ioConfigs[])
  private readonly ioConfigCache = new Map<string, { configs: DeviceIoConfig[]; expiry: number }>();
  private readonly DEVICE_CACHE_TTL_MS = 30_000; // 30 seconds

  // lastSeenAt debounce: sensorId -> last flush timestamp
  private readonly lastSeenPending = new Map<string, Date>();
  private lastSeenFlushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly LAST_SEEN_FLUSH_INTERVAL_MS = 30_000; // 30 seconds

  // Negative cache for topics that resolve to no sensor (HIGH-005 back-pressure)
  // Prevents the 150+ query legacy fallback from running repeatedly for unknown topics
  private readonly topicNegativeCache = new Map<string, number>(); // topic -> expiresAt
  private readonly NEGATIVE_CACHE_TTL_MS = 30_000; // 30 seconds

  // Legacy edge/ topic support (D04 SEC-M01)
  // Set LEGACY_EDGE_TOPICS_ENABLED=false to disable legacy edge/{deviceCode}/... topics
  // and force all devices to use tenant-prefixed tenants/{tenantId}/devices/{deviceCode}/... pattern
  private readonly legacyEdgeTopicsEnabled: boolean;

  // MQTT payload size limit (D04 SEC-L02)
  // Reject messages larger than 256KB to prevent memory abuse
  private static readonly MAX_PAYLOAD_SIZE = 256 * 1024; // 256KB

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly metricWriter: SensorMetricWriterService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
    @Optional()
    @Inject(EdgeDeviceService)
    private readonly edgeDeviceService: EdgeDeviceService | null,
    @Optional()
    @Inject(SensorTopicCacheService)
    private readonly sensorTopicCache: SensorTopicCacheService | null,
    @Optional()
    @Inject(MqttClientService)
    private readonly mqttClient: MqttClientService | null,
    @Optional()
    @Inject(DeploymentLogService)
    private readonly deploymentLogService: DeploymentLogService | null,
    @Optional()
    @Inject(AutomationService)
    private readonly automationService: AutomationService | null,
    @Optional()
    @Inject(ScadaDeployLogService)
    private readonly scadaDeployLogService: ScadaDeployLogService | null,
    @Optional()
    @Inject(ReleaseBundleService)
    private readonly releaseBundleService: ReleaseBundleService | null,
    @Optional()
    @Inject(ScadaPackageService)
    private readonly scadaPackageService: ScadaPackageService | null,
    // ADR-022 — when set, the profile service decides whether the
    // legacy MQTT data plane runs at boot. Optional to keep test
    // harnesses (which build the service via `new` instead of the DI
    // container) from breaking; when missing, the service falls back
    // to the legacy behaviour.
    @Optional()
    @Inject(SensorServiceProfileService)
    private readonly profile: SensorServiceProfileService | null = null,
    // SENSOR-CRITICAL-007 — resolves the pending edge-delegated VFD write when
    // the gateway acknowledges a write_modbus command. Optional so `new`-based
    // test harnesses and MQTT-less boots keep working.
    @Optional()
    @Inject(VfdEdgeWriteService)
    private readonly vfdEdgeWriteService: VfdEdgeWriteService | null = null,
    // SENSOR-CRITICAL-007 — resolves the pending edge provision/decommission when
    // the gateway acks a provision_modbus_device / decommission_modbus_device
    // command. Optional for the same `new`-based test-harness reason as above.
    @Optional()
    @Inject(VfdEdgeProvisioningService)
    private readonly vfdEdgeProvisioningService: VfdEdgeProvisioningService | null = null,
    // SENSOR-CRITICAL-007 — resolves the pending edge-delegated VFD read when the
    // gateway acks a read_modbus command (motor-state interlock + parameter
    // read-back). Optional for the same `new`-based test-harness reason as above.
    @Optional()
    @Inject(VfdEdgeReadService)
    private readonly vfdEdgeReadService: VfdEdgeReadService | null = null,
  ) {
    // Legacy edge/ topic flag (default: true for backward compatibility)
    this.legacyEdgeTopicsEnabled =
      this.configService.get('LEGACY_EDGE_TOPICS_ENABLED', 'true') === 'true';

    // Bind message handler to this instance
    this.messageHandler = (topic: string, message: Buffer) => {
      this.handleMessage(topic, message).catch((error: Error) => {
        this.logger.error(
          `Unhandled error in message handler for topic ${topic}: ${error.message}`,
          error.stack,
        );
      });
    };
  }

  async onModuleInit(): Promise<void> {
    // ADR-022 control / data plane split: on the control-plane profile
    // the Rust ingestion sidecar (ADR-025) owns MQTT subscribe + parse +
    // COPY. The NestJS MqttListener is then dead weight that would
    // double-consume QoS-1 messages and double-publish events. Skip
    // boot-time start; the legacy entry-points (registerSensorMqtt /
    // unregisterSensorMqtt) stay callable for the GraphQL CRUD path
    // that tests connectivity from the control plane.
    if (this.profile && !this.profile.isLegacyDataPlaneEnabled()) {
      this.logger.log(
        'SENSOR_SERVICE_PROFILE=control-plane: MQTT listener boot skipped (Rust sidecar owns the data plane).',
      );
      return;
    }
    const mqttEnabled = this.configService.get('MQTT_ENABLED', 'true') === 'true';

    if (!mqttEnabled) {
      this.logger.log('MQTT Listener is disabled');
      return;
    }

    if (!this.mqttClient) {
      this.logger.warn('MqttClientService not available, MQTT listener will not start');
      return;
    }

    // Register as message handler
    this.mqttClient.addMessageHandler(this.messageHandler);

    // If MQTT client is already connected, subscribe now; otherwise wait for connection
    if (this.mqttClient.isConnectedToBroker()) {
      await this.subscribeToTopics();
    } else {
      this.logger.log(
        'MQTT client not yet connected, will subscribe when connection is established',
      );
      this.mqttClient.onceConnected(() => {
        this.logger.log('MQTT client connected — subscribing to topics now');
        this.subscribeToTopics().catch((err) => {
          this.logger.error(`Failed to subscribe after delayed connect: ${err}`);
        });
      });
    }

    // Start lastSeenAt flush timer
    this.lastSeenFlushTimer = setInterval(() => {
      this.flushLastSeenUpdates().catch((err) => {
        this.logger.error(
          `Failed to flush lastSeenAt updates: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.LAST_SEEN_FLUSH_INTERVAL_MS);

    this.logger.log('MQTT Listener initialized');
  }

  async onModuleDestroy(): Promise<void> {
    // Clear lastSeenAt flush timer
    if (this.lastSeenFlushTimer) {
      clearInterval(this.lastSeenFlushTimer);
      this.lastSeenFlushTimer = null;
    }
    // Flush any pending lastSeenAt updates
    await this.flushLastSeenUpdates();

    // Unregister message handler
    if (this.mqttClient) {
      this.mqttClient.removeMessageHandler(this.messageHandler);
    }
    this.logger.log('MQTT Listener destroyed');
  }

  /**
   * Subscribe to sensor and edge device topics
   */
  private async subscribeToTopics(): Promise<void> {
    if (!this.mqttClient) return;

    // Don't try to subscribe if not connected - will subscribe when connection is established
    if (!this.mqttClient.isConnectedToBroker()) {
      this.logger.warn('MQTT broker not connected, will subscribe when connection is established');
      return;
    }

    // Subscribe to wildcard topic patterns
    const topics = [
      // Sensor data topics
      'sensors/#', // All sensor data
      'aquaculture/+/sensors/#', // Tenant-specific sensors
      '+/+/+/temperature-array', // Array sensor pattern

      // Edge device topics - Tenant-prefixed pattern (Edge Agent v2.0 default)
      // Pattern: tenants/{tenantId}/devices/{deviceCode}/{messageType}
      'tenants/+/devices/+/telemetry', // Device telemetry (CPU, RAM, Disk, Temp)
      'tenants/+/devices/+/status', // Device status (online/offline)
      'tenants/+/devices/+/response', // Command response (legacy singular)
      'tenants/+/devices/+/responses', // Command response (plural - Edge Agent v2.0+)
      'tenants/+/devices/+/io_data', // I/O tag canlı değerleri (Edge Agent → Frontend bridge)
      'tenants/+/devices/+/alarms', // I/O alarm events (Edge Agent → Backend persist + WS bridge)
      'tenants/+/devices/+/capabilities', // v2.3: Boot-time hardware capabilities report
      'tenants/+/devices/+/lora_events', // LoRaWAN events (join_accept, uplink_summary)
    ];

    // Legacy edge/ topics (D04 SEC-M01): only subscribe when explicitly enabled
    // These topics lack tenant enforcement — migrate devices to tenant-prefixed topics
    if (this.legacyEdgeTopicsEnabled) {
      topics.push(
        'edge/+/heartbeat', // Device heartbeat (health metrics)
        'edge/+/birth', // Device birth certificate
        'edge/+/death', // Device death (LWT - Last Will Testament)
        'edge/+/response', // Command response from device (legacy singular)
        'edge/+/responses', // Command response from device (plural - Edge Agent v2.0+)
      );
      this.logger.warn(
        'Legacy edge/ topic subscriptions are ENABLED. ' +
          'These topics lack tenant enforcement. ' +
          'Set LEGACY_EDGE_TOPICS_ENABLED=false after migrating all devices to tenant-prefixed topics.',
      );
    } else {
      this.logger.log(
        'Legacy edge/ topic subscriptions are DISABLED. ' +
          'Only tenant-prefixed topics (tenants/{tenantId}/devices/{deviceCode}/...) are active.',
      );
    }

    try {
      await this.mqttClient.subscribe(topics);
    } catch (error) {
      this.logger.warn(`Failed to subscribe to topics: ${(error as Error).message}`);
    }
  }

  /**
   * Handle incoming MQTT message
   */
  private async handleMessage(topic: string, message: Buffer): Promise<void> {
    try {
      // D04 SEC-L02: Reject oversized payloads before any processing
      if (message.length > MqttListenerService.MAX_PAYLOAD_SIZE) {
        this.logger.warn(
          `Payload too large: ${message.length} bytes from topic ${topic} ` +
            `(limit: ${MqttListenerService.MAX_PAYLOAD_SIZE} bytes). Message dropped.`,
        );
        return;
      }

      const payload = message.toString();
      this.logger.debug(`Received message on ${topic}: ${payload.substring(0, 100)}`);

      // Route edge device messages - Legacy pattern (edge/{deviceCode}/{type})
      // D04 SEC-M01: Legacy topics lack tenant enforcement — log deprecation warning
      if (topic.startsWith('edge/')) {
        if (!this.legacyEdgeTopicsEnabled) {
          this.logger.warn(
            `Message received on disabled legacy topic ${topic}. ` +
              'Legacy edge/ topics are disabled (LEGACY_EDGE_TOPICS_ENABLED=false). Message dropped.',
          );
          return;
        }
        this.logger.warn(
          `[DEPRECATED] Message received on legacy topic ${topic}. ` +
            'Legacy edge/ topics lack tenant enforcement and will be removed in a future release. ' +
            'Migrate device to tenant-prefixed topic: tenants/{tenantId}/devices/{deviceCode}/...',
        );
        await this.handleEdgeDeviceMessage(topic, message);
        return;
      }

      // Route edge device messages - Tenant-prefixed pattern (tenants/{tenantId}/devices/{deviceCode}/{type})
      if (topic.startsWith('tenants/')) {
        await this.handleTenantPrefixedEdgeMessage(topic, message);
        return;
      }

      // Parse topic to extract identifiers
      const parsedTopic = this.parseTopic(topic);

      // Try to find sensor by topic pattern
      const sensor = await this.findSensorByTopic(topic, parsedTopic);

      if (!sensor) {
        this.logger.debug(`No sensor found for topic: ${topic}`);
        return;
      }

      // Parse message payload
      const data = this.parsePayload(payload, sensor);

      if (!data) {
        this.logger.warn(`Failed to parse payload for topic ${topic}`);
        return;
      }

      const now = new Date();

      // Save reading
      await this.saveReading(sensor, data);

      // Debounce lastSeenAt update (flushed every 30 seconds)
      this.lastSeenPending.set(sensor.id, now);

      // Publish real-time event for WebSocket clients
      await this.publishSensorReadingEvent(sensor, data, now);
    } catch (error) {
      this.logger.error(`Error handling MQTT message: ${(error as Error).message}`);
    }
  }

  // ==================== Edge Device Handlers ====================

  /**
   * Route edge device messages to appropriate handlers
   * Topics: edge/{deviceCode}/heartbeat, edge/{deviceCode}/birth, edge/{deviceCode}/death, edge/{deviceCode}/response
   */
  private async handleEdgeDeviceMessage(topic: string, message: Buffer): Promise<void> {
    if (!this.edgeDeviceService) {
      this.logger.warn('EdgeDeviceService not available, skipping edge device message');
      return;
    }

    const parts = topic.split('/');
    if (parts.length < 3) {
      this.logger.warn(`Invalid edge device topic format: ${topic}`);
      return;
    }

    const deviceCode = parts[1] as string;
    const messageType = parts[2] as string;

    try {
      const payload = JSON.parse(message.toString()) as Record<string, unknown>;

      // SEC-M01: Legacy edge/ topics lack tenant enforcement in the topic path.
      // Look up the device by deviceCode to resolve its tenantId, then enforce
      // that the device actually belongs to a known tenant before processing.
      const legacyDevice = await this.edgeDeviceService.findByCodeOnly(deviceCode);
      if (!legacyDevice) {
        this.logger.warn(
          `[LEGACY TENANT ENFORCEMENT] Device ${deviceCode} not found in any tenant. ` +
            'Rejecting legacy edge/ message to prevent cross-tenant spoofing.',
        );
        return;
      }
      const resolvedTenantId = legacyDevice.tenantId;

      switch (messageType) {
        case 'heartbeat':
          await this.handleEdgeHeartbeat(
            deviceCode,
            payload as EdgeHeartbeatPayload,
            resolvedTenantId,
          );
          break;
        case 'birth':
          await this.handleEdgeBirth(deviceCode, payload as EdgeBirthPayload, resolvedTenantId);
          break;
        case 'death':
          await this.handleEdgeDeath(deviceCode, resolvedTenantId);
          break;
        case 'response':
        case 'responses':
          await this.handleEdgeResponse(
            deviceCode,
            payload as EdgeResponsePayload,
            resolvedTenantId,
          );
          break;
        default:
          this.logger.debug(`Unknown edge device message type: ${messageType}`);
      }
    } catch (error) {
      this.logger.error(`Failed to parse edge device message: ${(error as Error).message}`);
    }
  }

  /**
   * Handle edge device heartbeat message
   * Updates device health metrics in database
   */
  private async handleEdgeHeartbeat(
    deviceCode: string,
    payload: EdgeHeartbeatPayload,
    tenantId?: string,
  ): Promise<void> {
    this.logger.debug(
      `Edge heartbeat from ${deviceCode}: CPU=${payload.cpuUsage}%, Mem=${payload.memoryUsage}%`,
    );

    const heartbeat: DeviceHeartbeat = {
      deviceCode,
      ...(tenantId ? { tenantId } : {}),
      isOnline: payload.isOnline ?? true,
      status: payload.status,
      cpuUsage: payload.cpuUsage,
      memoryUsage: payload.memoryUsage,
      storageUsage: payload.storageUsage,
      temperatureCelsius: payload.temperatureCelsius,
      uptimeSeconds: payload.uptimeSeconds,
      firmwareVersion: payload.firmwareVersion,
      ipAddress: payload.ipAddress,
    };

    if (!this.edgeDeviceService) return;
    const device = await this.edgeDeviceService.updateHeartbeat(heartbeat);

    if (device) {
      this.logger.debug(`Updated heartbeat for device ${deviceCode} (${device.id})`);

      // Publish real-time event for WebSocket clients
      if (this.eventBus) {
        await this.eventBus.publish({
          ...createBaseEvent('EdgeDeviceHeartbeat', device.tenantId, {
            aggregateId: device.id,
            aggregateType: 'EdgeDevice',
          }),
          deviceId: device.id,
          deviceCode: device.deviceCode,
          isOnline: device.isOnline,
          cpuUsage: device.cpuUsage,
          memoryUsage: device.memoryUsage,
          storageUsage: device.storageUsage,
          temperatureCelsius: device.temperatureCelsius,
        });
      }
    }
  }

  /**
   * Handle edge device birth message (device came online)
   * @param tenantId Optional tenantId extracted from MQTT topic for boundary enforcement
   */
  private async handleEdgeBirth(
    deviceCode: string,
    payload: EdgeBirthPayload,
    tenantId?: string,
  ): Promise<void> {
    this.logger.log(`Edge device birth: ${deviceCode}`);

    // Update device as online with birth certificate data
    // Include tenantId (when available from topic) so updateHeartbeat enforces tenant boundary
    const heartbeat: DeviceHeartbeat = {
      deviceCode,
      ...(tenantId ? { tenantId } : {}),
      isOnline: true,
      firmwareVersion: payload.firmwareVersion ?? payload.properties?.firmwareVersion,
      ipAddress: payload.ipAddress ?? payload.properties?.ipAddress,
    };

    if (!this.edgeDeviceService) return;
    await this.edgeDeviceService.updateHeartbeat(heartbeat);
  }

  /**
   * Handle edge device death message (device went offline - LWT)
   * @param tenantId Optional tenantId extracted from MQTT topic for boundary enforcement
   */
  private async handleEdgeDeath(deviceCode: string, tenantId?: string): Promise<void> {
    this.logger.warn(`Edge device death: ${deviceCode}`);

    // Mark device as offline
    // Include tenantId (when available from topic) so updateHeartbeat enforces tenant boundary
    const heartbeat: DeviceHeartbeat = {
      deviceCode,
      ...(tenantId ? { tenantId } : {}),
      isOnline: false,
    };

    if (!this.edgeDeviceService) return;
    await this.edgeDeviceService.updateHeartbeat(heartbeat);
  }

  /**
   * Handle edge device command response
   * @param deviceCode The device code that sent the response
   * @param payload The response payload from the edge device
   * @param tenantId Optional tenantId extracted from MQTT topic (tenant-prefixed topics)
   */
  private async handleEdgeResponse(
    deviceCode: string,
    payload: EdgeResponsePayload,
    tenantId?: string,
  ): Promise<void> {
    this.logger.debug(`Edge response from ${deviceCode}: ${JSON.stringify(payload)}`);

    // Edge agent's CommandResponse does NOT include a "command" field —
    // only commandId, deviceId, success, result, error, timestamp.
    // Route by commandId: try all pending promise maps (ping, scan).
    if (this.edgeDeviceService && payload.commandId) {
      // Try ping first (most common)
      this.edgeDeviceService.handlePingResponse(deviceCode, payload as Record<string, unknown>);
      // Try scan_hardware
      this.edgeDeviceService.handleScanHardwareResponse(
        deviceCode,
        payload as Record<string, unknown>,
      );
    }

    // SENSOR-CRITICAL-007 — resolve a pending edge-delegated VFD write. No-op
    // unless the commandId matches a write this process published (the map is
    // keyed by the per-write random commandId, so ping/scan/deploy acks fall
    // straight through).
    if (this.vfdEdgeWriteService && payload.commandId) {
      this.vfdEdgeWriteService.handleWriteResponse(payload as Record<string, unknown>);
    }

    // SENSOR-CRITICAL-007 — resolve a pending edge provision/decommission ack.
    // Same per-command commandId correlation; a no-op for unrelated acks.
    if (this.vfdEdgeProvisioningService && payload.commandId) {
      this.vfdEdgeProvisioningService.handleProvisionResponse(payload as Record<string, unknown>);
    }

    // SENSOR-CRITICAL-007 — resolve a pending edge-delegated VFD read (motor-state
    // interlock + parameter read-back). Same commandId correlation.
    if (this.vfdEdgeReadService && payload.commandId) {
      this.vfdEdgeReadService.handleReadResponse(payload as Record<string, unknown>);
    }

    // SENSOR-HIGH-064 — correlate the edge's update_io_config ack back to the
    // pending push by commandId. The edge CommandResponse carries no `command`
    // field (see comment above), so the old `payload.command === 'update_io_config'`
    // match never fired — the push reported unconditional green and this ack loop
    // was dead. Routing by commandId settles the push that pushIoConfigToDevice()
    // is awaiting; a no-op for any response that is not an awaited config push.
    if (this.edgeDeviceService && payload.commandId) {
      const ack = this.edgeDeviceService.handleIoConfigAckResponse(
        deviceCode,
        payload as Record<string, unknown>,
      );
      if (ack.matched) {
        if (ack.success) {
          this.logger.log(`I/O config accepted by ${deviceCode} (command: ${payload.commandId})`);
        } else {
          this.logger.warn(
            `I/O config rejected by ${deviceCode} (command: ${payload.commandId}): ` +
              `${ack.error ?? 'unknown error'}`,
          );
        }

        // Emit the real-time result event exactly once, only on a real ack.
        if (this.eventBus) {
          await this.eventBus.publish({
            ...createBaseEvent('IoConfigPushResult', ack.tenantId || tenantId || SYSTEM_TENANT_ID, {
              aggregateId: ack.deviceId ?? deviceCode,
              aggregateType: 'EdgeDevice',
            }),
            deviceCode,
            commandId: payload.commandId,
            success: ack.success ?? false,
            error: ack.error,
          });
        }
      }
    }

    // Route deployment responses to DeploymentLogService and AutomationService
    const isDeployCommand =
      payload.command === 'deploy_program' ||
      payload.command === 'deploy_to_codesys' ||
      payload.command === 'deploy_auto';

    if ((isDeployCommand || payload.command === 'rollback_program') && payload.commandId) {
      try {
        if (isDeployCommand) {
          // Update deployment log
          if (this.deploymentLogService) {
            await this.deploymentLogService.handleResponse(
              payload.commandId,
              payload.success ?? false,
              payload.error,
            );
          }

          // Update program status via AutomationService (DEPLOYING -> DEPLOYED or APPROVED)
          if (this.automationService && tenantId) {
            const deploymentLog = this.deploymentLogService
              ? await this.findDeploymentLogByCommandId(payload.commandId)
              : null;

            if (deploymentLog) {
              if (payload.success) {
                await this.automationService.confirmDeployment(
                  deploymentLog.programId,
                  tenantId,
                  payload.commandId,
                );
              } else {
                await this.automationService.failDeployment(
                  deploymentLog.programId,
                  tenantId,
                  payload.commandId,
                  payload.error || 'Deployment failed on device',
                );
              }
            } else {
              this.logger.warn(
                `Cannot update program status: deployment log not found for command ${payload.commandId}`,
              );
            }
          }
        } else if (payload.command === 'rollback_program') {
          if (this.deploymentLogService) {
            await this.deploymentLogService.markRolledBack(payload.commandId);
          }

          // On successful rollback, revert program status to APPROVED
          if (this.automationService && tenantId && payload.success) {
            const deploymentLog = await this.findDeploymentLogByCommandId(payload.commandId);
            if (deploymentLog) {
              await this.automationService.failDeployment(
                deploymentLog.programId,
                tenantId,
                payload.commandId,
                'Rolled back to previous version',
              );
            }
          }
        }

        this.logger.log(
          `Deployment response processed for command ${payload.commandId}: success=${payload.success}`,
        );
      } catch (error) {
        this.logger.error(`Failed to process deployment response: ${(error as Error).message}`);
      }
    }

    // Route SCADA deploy responses to ScadaDeployLogService
    if (payload.command === 'deploy_scada_package' && payload.commandId) {
      try {
        if (this.scadaDeployLogService) {
          if (payload.success) {
            await this.scadaDeployLogService.updateStatus(
              payload.commandId,
              ScadaDeployStatus.SUCCESS,
              undefined,
              tenantId,
            );
            this.logger.log(`SCADA deploy succeeded for command ${payload.commandId}`);
          } else {
            await this.scadaDeployLogService.updateStatus(
              payload.commandId,
              ScadaDeployStatus.FAILED,
              { errorMessage: payload.error || 'SCADA deployment failed on device' },
              tenantId,
            );
            this.logger.warn(
              `SCADA deploy failed for command ${payload.commandId}: ${payload.error || 'unknown error'}`,
            );
          }
        } else {
          this.logger.warn(
            `ScadaDeployLogService not available — cannot update deploy status for command ${payload.commandId}`,
          );
        }
      } catch (error) {
        this.logger.error(`Failed to process SCADA deploy response: ${(error as Error).message}`);
      }
    }

    // Route SCADA undeploy acks (WF-011): the delete flow logged an
    // UNDEPLOY_SENT row per device; the device's ack settles it.
    if (payload.command === 'undeploy_scada_package' && payload.commandId) {
      try {
        if (this.scadaDeployLogService) {
          if (payload.success) {
            await this.scadaDeployLogService.updateStatus(
              payload.commandId,
              ScadaDeployStatus.UNDEPLOYED,
              undefined,
              tenantId,
            );
            this.logger.log(`SCADA undeploy confirmed for command ${payload.commandId}`);
          } else {
            await this.scadaDeployLogService.updateStatus(
              payload.commandId,
              ScadaDeployStatus.FAILED,
              { errorMessage: payload.error || 'SCADA undeploy failed on device' },
              tenantId,
            );
            this.logger.warn(
              `SCADA undeploy failed for command ${payload.commandId}: ${payload.error || 'unknown error'}`,
            );
          }
        } else {
          this.logger.warn(
            `ScadaDeployLogService not available — cannot update undeploy status for command ${payload.commandId}`,
          );
        }
      } catch (error) {
        this.logger.error(`Failed to process SCADA undeploy response: ${(error as Error).message}`);
      }
    }

    // Route release-bundle acks (Faz 5): the edge publishes an
    // intermediate `staged` ack and a final `confirmed`/`failed`
    // command response, all carrying result.bundleId + result.phase
    // under the bundle's commandId.
    const bundleAck = this.extractBundleAck(payload);
    if (bundleAck && payload.commandId && tenantId) {
      await this.handleBundleAck(tenantId, payload.commandId, bundleAck, payload.error);
    }

    // Publish response event for command tracking
    if (this.eventBus) {
      await this.eventBus.publish({
        ...createBaseEvent('EdgeDeviceResponse', tenantId || SYSTEM_TENANT_ID, {
          aggregateId: deviceCode,
          aggregateType: 'EdgeDevice',
        }),
        deviceCode,
        commandId: payload.commandId,
        success: payload.success,
        command: payload.command,
        data: payload.data,
        error: payload.error,
      });
    }
  }

  /**
   * The edge agent's CommandResponse carries the handler payload under
   * `result`; bundle acks put `{ bundleId, phase }` there.
   */
  private extractBundleAck(
    payload: EdgeResponsePayload,
  ): { bundleId: string; phase: string } | null {
    const raw = (payload as Record<string, unknown>).result ?? payload.data;
    if (raw === null || typeof raw !== 'object') return null;
    const candidate = raw as { bundleId?: unknown; phase?: unknown };
    if (typeof candidate.bundleId !== 'string' || typeof candidate.phase !== 'string') {
      return null;
    }
    return { bundleId: candidate.bundleId, phase: candidate.phase };
  }

  /**
   * Drive the release-bundle state machine from edge acks and fan the
   * terminal outcome out to the per-artifact deploy logs + source-entity
   * lifecycles (program DEPLOYING→DEPLOYED, package →PUBLISHED). This is
   * the CONFIRMED leg the SCADA path never had — the bundle is not "done"
   * when the command leaves the broker, only when the device confirms the
   * atomic apply.
   */
  private async handleBundleAck(
    tenantId: string,
    commandId: string,
    ack: { bundleId: string; phase: string },
    edgeError?: string,
  ): Promise<void> {
    if (!this.releaseBundleService) {
      this.logger.warn(
        `ReleaseBundleService not available — bundle ack for ${ack.bundleId} dropped`,
      );
      return;
    }

    try {
      switch (ack.phase) {
        case 'staged': {
          await this.releaseBundleService.markStaged(tenantId, commandId);
          this.logger.log(`Bundle ${ack.bundleId} STAGED by device (command ${commandId})`);
          break;
        }
        case 'confirmed': {
          const bundle = await this.releaseBundleService.markConfirmed(tenantId, commandId);
          this.logger.log(`Bundle ${ack.bundleId} CONFIRMED by device (command ${commandId})`);
          await this.fanOutBundleOutcome(tenantId, bundle, true, undefined);
          break;
        }
        case 'failed': {
          const message = edgeError || 'Bundle deploy failed on device';
          const bundle = await this.releaseBundleService.markFailed(tenantId, commandId, message);
          this.logger.warn(
            `Bundle ${ack.bundleId} FAILED on device (command ${commandId}): ${message}`,
          );
          await this.fanOutBundleOutcome(tenantId, bundle, false, message);
          break;
        }
        default:
          this.logger.warn(`Unknown bundle ack phase "${ack.phase}" for ${ack.bundleId}`);
      }
    } catch (error) {
      // Illegal transitions here are duplicate/late acks — log, never throw
      // (the state machine already refused to regress).
      this.logger.warn(
        `Bundle ack ${ack.phase} for ${ack.bundleId} not applied: ${(error as Error).message}`,
      );
    }
  }

  /** Per-artifact deploy-log + lifecycle fan-out for a terminal bundle ack. */
  private async fanOutBundleOutcome(
    tenantId: string,
    bundle: ReleaseBundle,
    success: boolean,
    errorMessage?: string,
  ): Promise<void> {
    for (const artifact of bundle.manifest.artifacts) {
      try {
        if (artifact.kind === DeployArtifactType.AUTOMATION_PROGRAM) {
          if (artifact.logCommandId && this.deploymentLogService) {
            await this.deploymentLogService.handleResponse(
              artifact.logCommandId,
              success,
              errorMessage,
            );
          }
          if (artifact.sourceEntityId && artifact.logCommandId && this.automationService) {
            if (success) {
              await this.automationService.confirmDeployment(
                artifact.sourceEntityId,
                tenantId,
                artifact.logCommandId,
              );
            } else {
              await this.automationService.failDeployment(
                artifact.sourceEntityId,
                tenantId,
                artifact.logCommandId,
                errorMessage || 'Bundle deploy failed on device',
              );
            }
          }
        } else if (artifact.kind === DeployArtifactType.SCADA_PACKAGE) {
          if (artifact.logCommandId && this.scadaDeployLogService) {
            await this.scadaDeployLogService.updateStatus(
              artifact.logCommandId,
              success ? ScadaDeployStatus.SUCCESS : ScadaDeployStatus.FAILED,
              success ? undefined : { errorMessage },
              tenantId,
            );
          }
          if (success && artifact.sourceEntityId && this.scadaPackageService) {
            await this.scadaPackageService.markPackagePublished(artifact.sourceEntityId, tenantId);
          }
        }
      } catch (error) {
        this.logger.error(
          `Bundle outcome fan-out failed for artifact ${artifact.artifactId}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Look up deployment log by commandId for program status updates
   * Returns the programId needed to call confirmDeployment/failDeployment
   */
  private async findDeploymentLogByCommandId(
    commandId: string,
  ): Promise<{ programId: string } | null> {
    if (!this.deploymentLogService) return null;

    try {
      // Use the dataSource to query directly since DeploymentLogService
      // doesn't expose a findByCommandId method
      const result = await this.dataSource.query(
        `SELECT program_id FROM "deployment_logs" WHERE command_id = $1 LIMIT 1`,
        [commandId],
      );
      if (result && result.length > 0 && result[0].program_id) {
        return { programId: result[0].program_id };
      }
      return null;
    } catch (error) {
      this.logger.error(
        `Failed to look up deployment log for command ${commandId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  // ==================== Tenant-Prefixed Edge Device Handlers ====================

  /**
   * Handle tenant-prefixed edge device messages (Edge Agent v2.0 format)
   *
   * Topic patterns:
   *   tenants/{tenantId}/devices/{deviceCode}/telemetry  - System metrics (CPU, RAM, Disk, Temp)
   *   tenants/{tenantId}/devices/{deviceCode}/status     - Device status (online/offline)
   *   tenants/{tenantId}/devices/{deviceCode}/response   - Command response
   *
   * Edge Agent TelemetryMetrics format (from edge-agent/src/telemetry.rs):
   * {
   *   "timestamp": "2026-01-13T10:00:00Z",
   *   "cpu_usage_percent": 15.5,
   *   "memory_usage_percent": 25.0,
   *   "disk_usage_percent": 40.0,
   *   "temperature_celsius": 45.2,
   *   "network_rx_bytes": 1234567,
   *   "network_tx_bytes": 987654,
   *   "uptime_secs": 86400
   * }
   */
  private async handleTenantPrefixedEdgeMessage(topic: string, message: Buffer): Promise<void> {
    if (!this.edgeDeviceService) {
      this.logger.warn('EdgeDeviceService not available for tenant-prefixed message');
      return;
    }

    const parts = topic.split('/');
    // Expected: tenants/{tenantId}/devices/{deviceCode}/{messageType}
    if (parts.length < 5) {
      this.logger.warn(`Invalid tenant-prefixed topic format: ${topic}`);
      return;
    }

    const tenantId = parts[1];
    const deviceCode = parts[3];
    const messageType = parts[4];

    if (!tenantId || !deviceCode || !messageType) {
      this.logger.warn(`Missing required parts in topic: ${topic}`);
      return;
    }

    try {
      const payload = JSON.parse(message.toString()) as Record<string, unknown>;

      switch (messageType) {
        case 'telemetry':
          await this.handleTenantEdgeTelemetry(
            tenantId,
            deviceCode,
            payload as TenantEdgeTelemetryPayload,
          );
          break;

        case 'status':
          await this.handleTenantEdgeStatus(
            tenantId,
            deviceCode,
            payload as TenantEdgeStatusPayload,
          );
          break;

        case 'response':
        case 'responses':
          await this.handleEdgeResponse(deviceCode, payload as EdgeResponsePayload, tenantId);
          break;

        case 'io_data':
          // Edge agent'ın gönderdiği I/O tag değerlerini WebSocket'e bridge et
          // Bu sayede process editor'daki equipment node'ları canlı I/O verisi gösterebilir
          await this.handleEdgeIoData(tenantId, deviceCode, payload);
          break;

        case 'alarms':
          // Edge agent alarm event'lerini EventBus + device_events tablosuna persist et
          await this.handleEdgeAlarms(tenantId, deviceCode, payload);
          break;

        case 'capabilities':
          // v2.3: Boot-time hardware capabilities report from edge agent.
          // Updates the device's capabilities JSONB field for UI display.
          await this.handleEdgeCapabilities(tenantId, deviceCode, payload);
          break;

        case 'lora_events':
          // LoRaWAN event'leri: join_accept, uplink_summary
          // Edge agent, SX1302 concentrator üzerinden LoRa cihazlarının
          // durumunu bu topic'e publish eder.
          await this.handleLoRaEvents(tenantId, deviceCode, payload);
          break;

        default:
          this.logger.debug(`Unknown tenant edge message type: ${messageType}`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to parse tenant-prefixed message on ${topic}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Handle telemetry from Edge Agent (tenant-prefixed topic)
   * Converts Edge Agent TelemetryMetrics format to DeviceHeartbeat
   */
  private async handleTenantEdgeTelemetry(
    tenantId: string,
    deviceCode: string,
    payload: TenantEdgeTelemetryPayload,
  ): Promise<void> {
    // Edge Agent sends metrics nested under "metrics" key:
    //   { device_id, device_code, timestamp, metrics: { cpu_usage_percent, ... } }
    // Unwrap nested metrics, fall back to flat fields for backward compatibility
    const m: TelemetryMetricsFields = payload.metrics ?? payload;

    // Include tenantId from the MQTT topic so updateHeartbeat enforces tenant boundary
    const heartbeat: DeviceHeartbeat = {
      deviceCode,
      tenantId,
      isOnline: true,
      cpuUsage: m.cpu_usage_percent != null ? Math.round(m.cpu_usage_percent) : m.cpuUsage,
      memoryUsage:
        m.memory_usage_percent != null ? Math.round(m.memory_usage_percent) : m.memoryUsage,
      storageUsage:
        m.disk_usage_percent != null ? Math.round(m.disk_usage_percent) : m.storageUsage,
      temperatureCelsius: m.temperature_celsius ?? m.temperatureCelsius,
      uptimeSeconds: m.uptime_secs != null ? Math.round(m.uptime_secs) : m.uptimeSeconds,
      firmwareVersion: m.agent_version ?? m.firmwareVersion ?? payload.agent_version,
      ipAddress: m.ip_address ?? m.ipAddress,
    };

    if (!this.edgeDeviceService) return;
    const device = await this.edgeDeviceService.updateHeartbeat(heartbeat);

    if (device) {
      this.logger.debug(
        `Tenant ${tenantId} edge telemetry from ${deviceCode}: ` +
          `CPU=${heartbeat.cpuUsage?.toFixed(1)}%, ` +
          `RAM=${heartbeat.memoryUsage?.toFixed(1)}%, ` +
          `Disk=${heartbeat.storageUsage?.toFixed(1)}%`,
      );

      // Publish real-time event for WebSocket clients
      if (this.eventBus) {
        await this.eventBus.publish({
          ...createBaseEvent('EdgeDeviceHeartbeat', device.tenantId, {
            aggregateId: device.id,
            aggregateType: 'EdgeDevice',
          }),
          deviceId: device.id,
          deviceCode: device.deviceCode,
          isOnline: device.isOnline,
          cpuUsage: device.cpuUsage,
          memoryUsage: device.memoryUsage,
          storageUsage: device.storageUsage,
          temperatureCelsius: device.temperatureCelsius,
          uptimeSeconds: device.uptimeSeconds,
        });
      }
    } else {
      this.logger.warn(
        `No device found for telemetry: tenantId=${tenantId}, deviceCode=${deviceCode}`,
      );
    }
  }

  /**
   * Handle status message from Edge Agent (tenant-prefixed topic)
   * Status can be: online, offline, error
   */
  private async handleTenantEdgeStatus(
    tenantId: string,
    deviceCode: string,
    payload: TenantEdgeStatusPayload,
  ): Promise<void> {
    const isOnline = payload.online ?? payload.isOnline ?? payload.status === 'online';

    if (isOnline) {
      this.logger.log(`Tenant ${tenantId} edge device online: ${deviceCode}`);
      // Build heartbeat directly from status payload fields —
      // the Rust agent sends agent_version, uptime_seconds, and status in StatusMessage.
      // Previously this called handleEdgeBirth with { firmwareVersion: undefined, ipAddress: undefined }
      // which would risk clearing those fields if updateHeartbeat guards ever changed.
      const heartbeat: DeviceHeartbeat = {
        deviceCode,
        tenantId,
        isOnline: true,
        status: payload.status,
        firmwareVersion: payload.agent_version,
        uptimeSeconds:
          payload.uptime_seconds != null ? Math.round(payload.uptime_seconds) : undefined,
      };

      if (!this.edgeDeviceService) return;
      await this.edgeDeviceService.updateHeartbeat(heartbeat);
    } else {
      this.logger.warn(`Tenant ${tenantId} edge device offline: ${deviceCode}`);
      // Build heartbeat with status for lifecycle state mapping
      const heartbeat: DeviceHeartbeat = {
        deviceCode,
        tenantId,
        isOnline: false,
        status: payload.status,
      };

      if (!this.edgeDeviceService) return;
      await this.edgeDeviceService.updateHeartbeat(heartbeat);
    }
  }

  // ==================== I/O Data Bridge (Faz F — Kemik Yapı) ====================
  //
  // Edge agent, scan cycle'da okuduğu I/O değerlerini
  // tenants/{tid}/devices/{code}/io_data topic'ine publish eder.
  // Bu handler, gelen veriyi EventBus üzerinden WebSocket'e iletir.
  // Frontend'deki EquipmentNodeOverlay bu event'i dinleyerek
  // canlı I/O değerlerini node üzerinde gösterir.
  //
  // Beklenen payload formatı (edge agent'tan):
  // {
  //   "timestamp": "2026-01-15T12:00:00Z",
  //   "tags": {
  //     "pump1_run": { "value": true, "quality": "good" },
  //     "temp_inlet": { "value": 23.5, "quality": "good" }
  //   }
  // }
  // ================================================================

  /**
   * Per-device I/O data throttle — yüksek frekanslı scan cycle verilerini
   * WebSocket'e iletmeden önce frekans sınırlaması uygular.
   * Key: "tenantId:deviceCode", Value: son publish timestamp (ms)
   *
   * Edge agent'lar tipik olarak 100-500ms aralıklarla I/O verisi gönderir,
   * ancak frontend'in bu hızda güncellenmesi gereksiz ve WebSocket'i yorar.
   * IO_DATA_THROTTLE_MS ile minimum aralık belirlenir (varsayılan 1000ms).
   */
  private readonly ioDataThrottleMap = new Map<string, number>();
  private static readonly IO_DATA_THROTTLE_MS = 1000;

  /** Payload boyut limiti (64 KB) — anormal büyüklükteki paketleri reddet */
  private static readonly IO_DATA_MAX_PAYLOAD_SIZE = 65_536;

  /** Maksimum tag sayısı per payload — bellek tüketimini sınırla */
  private static readonly IO_DATA_MAX_TAGS = 256;

  /**
   * Handle I/O data from edge agent and bridge to WebSocket.
   * Edge agent'ın scan cycle'da okuduğu I/O değerlerini frontend'e iletir.
   *
   * Güvenlik katmanları:
   *   1. Payload boyut kontrolü — DDoS/memory abuse önlemi
   *   2. Payload yapı doğrulaması — tags objesinin varlığı ve tipi
   *   3. Tag sayısı limiti — anormal veri paketlerini reddet
   *   4. Per-device throttle — WebSocket flooding önlemi
   */
  private async handleEdgeIoData(
    tenantId: string,
    deviceCode: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // 1. Payload boyut kontrolü — serialize edip byte cinsinden kontrol et
    //    Anormal büyük payload'lar bellek sızıntısına veya EventBus tıkanıklığına yol açabilir
    const payloadStr = JSON.stringify(payload);
    if (payloadStr.length > MqttListenerService.IO_DATA_MAX_PAYLOAD_SIZE) {
      this.logger.warn(
        `I/O data payload too large from ${deviceCode}: ${payloadStr.length} bytes (limit: ${MqttListenerService.IO_DATA_MAX_PAYLOAD_SIZE})`,
      );
      return;
    }

    // 2. Payload yapı doğrulaması — "tags" alanı object olmalı
    //    Edge agent'ın beklenen formatı: { tags: { tagName: { value, quality } } }
    const tags = payload['tags'];
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
      this.logger.warn(
        `I/O data from ${deviceCode} has invalid structure — expected { tags: {...} }, got: ${payloadStr.substring(0, 100)}`,
      );
      return;
    }

    // 3. Tag sayısı kontrolü — anormal miktarda tag gönderimini engelle
    const tagCount = Object.keys(tags as Record<string, unknown>).length;
    if (tagCount > MqttListenerService.IO_DATA_MAX_TAGS) {
      this.logger.warn(
        `I/O data from ${deviceCode} has ${tagCount} tags (limit: ${MqttListenerService.IO_DATA_MAX_TAGS})`,
      );
      return;
    }

    // 4. Per-device throttle — aynı cihazdan çok hızlı gelen verileri filtrele
    //    Frontend 1 saniyede 1'den fazla güncellemeye ihtiyaç duymaz
    const throttleKey = `${tenantId}:${deviceCode}`;
    const now = Date.now();
    const lastPublish = this.ioDataThrottleMap.get(throttleKey) || 0;
    if (now - lastPublish < MqttListenerService.IO_DATA_THROTTLE_MS) {
      return; // Sessizce atla — debug log bile gereksiz, çünkü çok sık olur
    }
    this.ioDataThrottleMap.set(throttleKey, now);

    this.logger.debug(`I/O data from ${deviceCode}: ${payloadStr.substring(0, 200)}`);

    // 5. EventBus üzerinden WebSocket'e ilet
    //    Frontend'deki useSensorSocket veya özel hook bu event'i dinler
    if (this.eventBus) {
      // ARCH-C01: Serialize tags to JSON string — flat-object contract
      await this.eventBus.publish({
        ...createBaseEvent('EdgeDeviceIoData', tenantId, {
          aggregateId: deviceCode,
          aggregateType: 'EdgeDevice',
          version: 2,
        }),
        deviceCode,
        tagsJson: JSON.stringify(tags),
      });
    }

    // 6. Persist to sensor_metrics for historical data
    await this.persistIoDataToMetrics(
      tenantId,
      deviceCode,
      tags as Record<string, { value: number | string | boolean; quality: string }>,
    );
  }

  // ==================== I/O Data Persistence ====================

  /**
   * Persist io_data tag values to sensor_metrics for historical trending.
   * Maps edge device → sensor, ioConfig → channel.
   */
  private async persistIoDataToMetrics(
    tenantId: string,
    deviceCode: string,
    tags: Record<string, { value: number | string | boolean; quality: string }>,
  ): Promise<void> {
    try {
      // Lookup device (cached)
      const device = await this.getCachedDevice(tenantId, deviceCode);
      if (!device) {
        this.logger.warn(`Device not found for io_data persist: ${deviceCode}`);
        return;
      }

      // Lookup io configs (cached)
      const ioConfigs = await this.getCachedIoConfigs(device.id, tenantId);

      // Build tag->config map
      const configMap = new Map(ioConfigs.map((c: DeviceIoConfig) => [c.tagName, c]));

      // Quality code mapping (edge agent quality strings → OPC-UA quality codes)
      const qualityMap: Record<string, number> = {
        good: 192,
        uncertain: 64,
        bad: 0,
        comm_failure: 24,
        not_initialized: 32,
      };

      // Build metric inputs and hand to the single sensor.sensor_metrics writer.
      const timestamp = new Date();
      const inputs: SensorMetricInput[] = [];

      for (const [tagName, tagData] of Object.entries(tags)) {
        const config = configMap.get(tagName);
        if (!config) continue;

        const numericValue =
          typeof tagData.value === 'boolean' ? (tagData.value ? 1.0 : 0.0) : Number(tagData.value);

        // Reject NaN AND Infinity — they corrupt TimescaleDB AVG/SUM aggregates.
        if (!Number.isFinite(numericValue)) continue;

        inputs.push({
          time: timestamp,
          sensorId: device.id, // device acts as sensor
          channelId: config.id, // ioConfig acts as channel
          tenantId,
          rawValue: numericValue,
          value: numericValue, // no calibration on io_data
          qualityCode: qualityMap[tagData.quality] ?? 0,
          qualityBits: 0,
          sourceProtocol: 'edge_io',
          sourceTimestamp: timestamp,
        });
      }

      if (inputs.length > 0) {
        await this.metricWriter.writeImmediate(inputs);
      }
    } catch (error) {
      this.logger.error(`Failed to persist io_data for ${deviceCode}: ${(error as Error).message}`);
    }
  }

  /**
   * Get device from cache or fetch from DB.
   *
   * SECURITY / DATA-INTEGRITY: MQTT handlers run outside any HTTP/GraphQL
   * request, so AsyncLocalStorage carries no tenant. edge_devices is a
   * per-tenant table, so an unscoped findByCode resolves against the empty
   * source-schema template and returns null — silently dropping the io_data
   * and alarm persistence that depend on this lookup. Wrap the fetch in
   * withTenantContext so the pool patch pins the correct tenant search_path,
   * matching getCachedIoConfigs and the device_events save.
   */
  private async getCachedDevice(tenantId: string, deviceCode: string): Promise<EdgeDevice | null> {
    const cacheKey = `${tenantId}:${deviceCode}`;
    const cached = this.deviceCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      return cached.device;
    }

    const device = await withTenantContext(tenantId, async () =>
      this.edgeDeviceService?.findByCode(deviceCode, tenantId),
    );
    if (device) {
      this.deviceCache.set(cacheKey, { device, expiry: Date.now() + this.DEVICE_CACHE_TTL_MS });
    }
    return device ?? null;
  }

  /**
   * Get active I/O configs for a device from cache or fetch from DB.
   * SECURITY: Uses withTenantContext in MQTT context where
   * AsyncLocalStorage has no tenant data (no HTTP request context).
   */
  private async getCachedIoConfigs(deviceId: string, tenantId: string): Promise<DeviceIoConfig[]> {
    const cached = this.ioConfigCache.get(deviceId);
    if (cached && cached.expiry > Date.now()) {
      return cached.configs;
    }

    const configs = await withTenantContext(tenantId, async () => {
      // DeviceIoConfig has no tenantId column — tenant scoping is
      // inherited from the parent EdgeDevice. The search_path pin in
      // withTenantContext + the deviceId WHERE provide the effective
      // isolation here. See ORPHAN-DIC-001.
      // eslint-disable-next-line no-restricted-syntax -- ORPHAN-DIC-001
      return this.dataSource
        .getRepository(DeviceIoConfig)
        .find({ where: { deviceId, isActive: true } });
    });

    this.ioConfigCache.set(deviceId, { configs, expiry: Date.now() + this.DEVICE_CACHE_TTL_MS });
    return configs;
  }

  // ==================== Alarm Handler ====================

  /**
   * Handle alarm events from edge agent.
   * Publishes to EventBus for WebSocket bridge and persists to device_events table.
   *
   * Expected payload format:
   * {
   *   "timestamp": "2026-03-03T12:00:00Z",
   *   "alarms": [
   *     { "tag": "temp_inlet", "type": "HH", "priority": "critical", "state": "active",
   *       "value": 32.5, "setpoint": 30.0, "message": "Temperature High-High alarm" }
   *   ]
   * }
   */
  private async handleEdgeAlarms(
    tenantId: string,
    deviceCode: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const alarms = (payload['alarms'] ?? []) as Array<Record<string, unknown>>;

      // Publish to EventBus for WebSocket bridge
      if (this.eventBus) {
        // ARCH-C01: Serialize alarms to JSON string — flat-object contract
        await this.eventBus.publish({
          ...createBaseEvent('EdgeDeviceAlarm', tenantId, {
            aggregateId: deviceCode,
            aggregateType: 'EdgeDevice',
            version: 2,
          }),
          deviceCode,
          alarmsJson: JSON.stringify(alarms),
          alarmCount: alarms.length,
        });
      }

      // Persist to device_events
      const device = await this.getCachedDevice(tenantId, deviceCode);
      if (!device) return;

      const events = alarms.map((alarm) => {
        const event = new DeviceEvent();
        event.tenantId = tenantId;
        event.deviceId = device.id;
        event.eventType = DeviceEventType.ALARM;
        event.severity = this.mapAlarmPriorityToSeverity(alarm['priority'] as string);
        event.message =
          (alarm['message'] as string) ||
          `Alarm ${alarm['type']} on ${alarm['tag']}: value=${alarm['value']}, setpoint=${alarm['setpoint']}`;
        event.metadata = {
          tagName: alarm['tag'],
          alarmType: alarm['type'],
          priority: alarm['priority'],
          state: alarm['state'],
          value: alarm['value'],
          setpoint: alarm['setpoint'],
        };
        return event;
      });

      // SECURITY: MQTT handlers run outside HTTP request context. Use
      // withTenantContext to establish AsyncLocalStorage context so the
      // pool patch sets the correct search_path on connection checkout.
      if (events.length > 0) {
        await withTenantContext(tenantId, async () => {
          // DeviceEvent has a tenantId column — use the scoped repo so
          // every event row carries the current tenant by construction.
          await TenantScopedRepository.create(this.dataSource, DeviceEvent, tenantId).saveMany(
            events,
          );
        });
      }
    } catch (error) {
      this.logger.error(`Failed to handle alarms from ${deviceCode}: ${(error as Error).message}`);
    }
  }

  /**
   * Map edge agent alarm priority string to DeviceEventSeverity enum.
   */
  private mapAlarmPriorityToSeverity(priority: string): DeviceEventSeverity {
    const lower = (priority ?? '').toLowerCase();
    if (lower.includes('critical')) return DeviceEventSeverity.CRITICAL;
    if (lower.includes('high')) return DeviceEventSeverity.ERROR;
    if (lower.includes('medium')) return DeviceEventSeverity.WARNING;
    return DeviceEventSeverity.INFO;
  }

  // ==================== Hardware Capabilities (v2.3) ====================

  /**
   * Handle boot-time hardware capabilities report from edge agent.
   *
   * Updates the device's `capabilities` JSONB field with the hardware
   * summary (platform, GPIO chip count, piControl availability, etc.).
   * This data drives the "Auto-Detect I/O" feature in the frontend.
   *
   * Topic: tenants/{tid}/devices/{code}/capabilities
   */
  private async handleEdgeCapabilities(
    tenantId: string,
    deviceCode: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.edgeDeviceService) return;

    this.logger.log(
      `Hardware capabilities from ${deviceCode}: platform=${payload['platform']}, ` +
        `gpio_chips=${payload['gpio_chip_count']}, gpio_lines=${payload['total_gpio_lines']}`,
    );

    // Build capabilities object for the JSONB column
    const capabilities: Record<string, boolean> = {
      hasGpio: Number(payload['total_gpio_lines'] ?? 0) > 0,
      hasPicontrol: !!payload['has_picontrol'],
      hasRppal: !!payload['rppal_available'],
      hasModbus: !!payload['modbus_configured'],
      autoDetectAvailable: true, // Agent supports scan_hardware command
    };

    try {
      // Find device by code and tenant, update capabilities
      const device = await this.edgeDeviceService.findByCode(deviceCode, tenantId);
      if (device) {
        await this.edgeDeviceService.updateDevice(device.id, tenantId, {
          capabilities,
        });
        this.logger.debug(`Capabilities updated for ${deviceCode}`);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to update capabilities for ${deviceCode}: ${(error as Error).message}`,
      );
    }
  }

  // ==================== LoRaWAN Event Handler ====================

  /**
   * Handle LoRaWAN events from edge agent.
   *
   * Edge agent, SX1302 concentrator üzerinden LoRa cihazlarının
   * join ve uplink durumlarını bu topic'e publish eder:
   *   tenants/{tid}/devices/{code}/lora_events
   *
   * Event tipleri:
   * - join_accept: Cihaz ağa başarıyla katıldı (OTAA). DevAddr atandı.
   * - uplink_summary: Uplink alındı. RSSI, SNR, frame counter güncellenir.
   *
   * Beklenen payload formatı:
   * {
   *   "event_type": "join_accept" | "uplink_summary",
   *   "dev_eui": "0011223344556677",
   *   "dev_addr": "26011234",           // join_accept'te
   *   "rssi": -65,                      // uplink_summary'de
   *   "snr": 8.5,                       // uplink_summary'de
   *   "frame_count_up": 42,             // uplink_summary'de
   *   "timestamp": "2026-03-03T12:00:00Z"
   * }
   */
  private async handleLoRaEvents(
    tenantId: string,
    deviceCode: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.edgeDeviceService) return;

    // Hem eski hem yeni alan adlarını kabul et (backward compat)
    const eventType = (payload['event_type'] ?? payload['type']) as string;
    const devEui = payload['dev_eui'] as string;

    if (!eventType || !devEui) {
      this.logger.warn(
        `Invalid lora_events payload from ${deviceCode}: missing event_type or dev_eui`,
      );
      return;
    }

    try {
      switch (eventType) {
        case 'join_accept': {
          // Cihaz OTAA ile ağa katıldı — isJoined ve devAddr güncelle
          this.logger.log(
            `LoRa join_accept: DevEUI=${devEui}, DevAddr=${payload['dev_addr']} via ${deviceCode}`,
          );
          await this.edgeDeviceService.updateLoRaDeviceStatus(devEui, {
            isJoined: true,
            joinedAt: new Date(),
            devAddr: (payload['dev_addr'] as string) ?? undefined,
          });
          break;
        }

        case 'uplink_summary': {
          // Uplink alındı — radio metrics güncelle
          // Hem eski hem yeni alan adlarını kabul et (backward compat)
          const frameCountUp = payload['frame_count_up'] ?? payload['f_cnt'];
          this.logger.debug(
            `LoRa uplink: DevEUI=${devEui}, RSSI=${payload['rssi']}, SNR=${payload['snr']}, FCntUp=${frameCountUp}`,
          );
          await this.edgeDeviceService.updateLoRaDeviceStatus(devEui, {
            lastSeenAt: new Date(),
            lastRssi: payload['rssi'] != null ? Number(payload['rssi']) : undefined,
            lastSnr: payload['snr'] != null ? Number(payload['snr']) : undefined,
            frameCountUp: frameCountUp != null ? Number(frameCountUp) : undefined,
          });
          break;
        }

        default:
          this.logger.debug(`Unknown lora_events type: ${eventType} from ${deviceCode}`);
      }

      // Publish to EventBus for WebSocket bridge — frontend LoRa device listesini canlı günceller
      if (this.eventBus) {
        await this.eventBus.publish({
          ...createBaseEvent('LoRaDeviceEvent', tenantId, {
            aggregateId: deviceCode,
            aggregateType: 'EdgeDevice',
          }),
          deviceCode,
          loraEventType: eventType,
          devEui,
          rssi: payload['rssi'],
          snr: payload['snr'],
          frameCountUp: payload['frame_count_up'],
          devAddr: payload['dev_addr'],
        });
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle lora_events from ${deviceCode}: ${(error as Error).message}`,
      );
    }
  }

  // ==================== Sensor Reading Events ====================

  /**
   * Publish sensor reading event for real-time updates
   */
  private async publishSensorReadingEvent(
    sensor: Sensor,
    data: Record<string, unknown>,
    timestamp: Date,
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    try {
      await this.eventBus.publish({
        ...createBaseEvent('SensorReading', sensor.tenantId, {
          aggregateId: sensor.id,
          aggregateType: 'Sensor',
        }),
        timestamp: timestamp.toISOString(),
        sensorId: sensor.id,
        readings: data,
        version: 1,
      });
      this.logger.debug(`Published SensorReading event for sensor ${sensor.id}`);
    } catch (error) {
      this.logger.warn(`Failed to publish sensor reading event: ${(error as Error).message}`);
    }
  }

  /**
   * Parse MQTT topic to extract identifiers
   */
  private parseTopic(topic: string): ParsedTopic | null {
    const parts = topic.split('/');

    // Pattern: sensors/{tenantId}/{sensorId}/data
    if (parts[0] === 'sensors' && parts.length >= 3 && parts[1] && parts[2]) {
      return {
        tenantId: parts[1],
        sensorId: parts[2],
        location: parts.slice(2, -1).join('/'),
      };
    }

    // Pattern: aquaculture/{tenantId}/sensors/{sensorId}
    if (
      parts[0] === 'aquaculture' &&
      parts[2] === 'sensors' &&
      parts.length >= 4 &&
      parts[1] &&
      parts[3]
    ) {
      return {
        tenantId: parts[1],
        sensorId: parts[3],
      };
    }

    // Pattern: {farm}/{pool}/{sensor-type} — no tenantId extractable
    if (parts.length >= 3) {
      this.logger.warn(`Cannot extract tenantId from topic: ${topic}`);
      return null; // Caller will skip — tenantId is required for multi-tenant isolation
    }

    return null;
  }

  /**
   * Find sensor by topic pattern - uses Redis cache for O(1) lookups
   *
   * PERFORMANCE OPTIMIZATION:
   * Previously this method searched ALL tenant schemas for EVERY MQTT message,
   * resulting in 150+ queries per message (1.5M queries/sec at 10K msg/sec).
   *
   * Now uses a multi-level cache:
   * 1. Local in-memory cache (1 minute TTL)
   * 2. Redis cache (1 hour TTL)
   * 3. Database fallback with cache population
   */
  private async findSensorByTopic(
    topic: string,
    parsed: ParsedTopic | null,
  ): Promise<Sensor | null> {
    try {
      // Use cache service if available (preferred path)
      if (this.sensorTopicCache) {
        const cachedInfo = await this.sensorTopicCache.getSensorByTopic(topic);

        if (cachedInfo) {
          // Load full sensor entity from the correct schema
          return await this.loadSensorFromCache(cachedInfo);
        }

        // Cache returned null - sensor not found
        return null;
      }

      // Fallback: Legacy cross-schema search (only if cache service unavailable)
      return await this.findSensorByTopicLegacy(topic, parsed);
    } catch (error) {
      this.logger.error(`Error in sensor lookup for topic ${topic}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Load full sensor entity from cached info.
   * Uses a dedicated read transaction so tenant search_path is scoped
   * and never leaks back to the pool (HIGH-001).
   */
  private async loadSensorFromCache(cachedInfo: CachedSensorInfo): Promise<Sensor | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query('SET TRANSACTION READ ONLY');
      await pinTenantSchemaTransactionSearchPath(queryRunner, 'sensor', cachedInfo.schemaName);
      const sensor = await queryRunner.manager.findOne(Sensor, {
        where: { id: cachedInfo.id },
      });
      await queryRunner.commitTransaction();
      return sensor;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      this.logger.error(
        `Error loading sensor ${cachedInfo.id} from cache: ${(error as Error).message}`,
      );
      return null;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Legacy cross-schema sensor lookup - used when cache service is unavailable
   * This is the original slow implementation for backward compatibility.
   *
   * HIGH-005: Negative cache prevents 150+ queries per message when Redis is unavailable.
   * Unknown topics are cached for 30 seconds and immediately return null without DB queries.
   */
  private async findSensorByTopicLegacy(
    topic: string,
    parsed: ParsedTopic | null,
  ): Promise<Sensor | null> {
    // Check negative cache before issuing any DB queries
    const negativeCacheExpiry = this.topicNegativeCache.get(topic);
    if (negativeCacheExpiry && negativeCacheExpiry > Date.now()) {
      return null;
    }

    try {
      // Get all tenant schemas through the shared canonical validator.
      const tenantSchemas = await listTenantSchemas(this.dataSource);

      // Search in each tenant schema using a dedicated QueryRunner so the
      // transaction-local search_path is scoped to a single connection and never
      // leaks back to the pool under concurrent MQTT messages (HIGH-001).
      for (const schemaName of tenantSchemas) {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
          await queryRunner.query('SET TRANSACTION READ ONLY');
          await pinTenantSchemaTransactionSearchPath(queryRunner, 'sensor', schemaName);

          // Check if sensors table exists in this schema
          const tableCheck: Array<{ '1': number }> = await queryRunner.query(
            `
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = 'sensors'
          `,
            [schemaName],
          );

          if (tableCheck.length === 0) {
            await queryRunner.commitTransaction();
            continue; // Skip schemas without sensors table
          }

          // Cross-tenant scan: this loop iterates through every tenant
          // schema searching for an MQTT-topic match. tenantManagerRepo
          // cannot be used because tenantId is not fixed — the whole
          // point of the scan is to FIND which tenant owns the topic.
          // The search_path pin above isolates the query to the current
          // schema in the loop; each iteration is a tenant-scoped
          // lookup by construction.
          // eslint-disable-next-line no-restricted-syntax -- cross-tenant topic-registry scan
          const sensorByTopic = await queryRunner.manager
            .getRepository(Sensor)
            .createQueryBuilder('sensor')
            .where(`sensor."protocol_configuration"->>'topic' = :topic`, { topic })
            .getOne();

          if (sensorByTopic) {
            this.logger.debug(
              `Found sensor ${sensorByTopic.id} in schema ${schemaName} for topic ${topic}`,
            );
            await queryRunner.commitTransaction();
            return sensorByTopic;
          }

          // Try wildcard match — same cross-tenant scan rationale as above.
          // eslint-disable-next-line no-restricted-syntax -- cross-tenant topic-registry scan
          const sensorsWithWildcard = await queryRunner.manager
            .getRepository(Sensor)
            .createQueryBuilder('sensor')
            .where(`sensor."protocol_configuration"->>'topic' LIKE '%#%'`)
            .orWhere(`sensor."protocol_configuration"->>'topic' LIKE '%+%'`)
            .getMany();

          for (const sensor of sensorsWithWildcard) {
            const configTopic = sensor.protocolConfiguration?.['topic'] as string;
            if (configTopic && this.topicMatches(configTopic, topic)) {
              this.logger.debug(
                `Found sensor ${sensor.id} in schema ${schemaName} via wildcard for topic ${topic}`,
              );
              await queryRunner.commitTransaction();
              return sensor;
            }
          }

          // Try by sensor ID from topic
          if (parsed?.sensorId) {
            const sensorById = await queryRunner.manager.findOne(Sensor, {
              where: { id: parsed.sensorId },
            });
            if (sensorById) {
              await queryRunner.commitTransaction();
              return sensorById;
            }

            // Try by serial number
            const sensorBySerial = await queryRunner.manager.findOne(Sensor, {
              where: { serialNumber: parsed.sensorId },
            });
            if (sensorBySerial) {
              await queryRunner.commitTransaction();
              return sensorBySerial;
            }
          }
          await queryRunner.commitTransaction();
        } catch (schemaError) {
          if (queryRunner.isTransactionActive) {
            await queryRunner.rollbackTransaction();
          }
          // Skip this schema if there's an error
          this.logger.debug(
            `Error searching in schema ${schemaName}: ${(schemaError as Error).message}`,
          );
          continue;
        } finally {
          await queryRunner.release();
        }
      }

      // No sensor found in any schema — populate negative cache to prevent re-querying
      this.topicNegativeCache.set(topic, Date.now() + this.NEGATIVE_CACHE_TTL_MS);
      this.logger.warn(
        `No sensor found for topic ${topic} (cached negative for ${this.NEGATIVE_CACHE_TTL_MS / 1000}s)`,
      );
      return null;
    } catch (error) {
      this.logger.error(`Error in cross-schema sensor lookup: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Check if topic matches pattern (supports + and # wildcards)
   */
  private topicMatches(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') {
        return true; // # matches everything remaining
      }
      if (patternParts[i] === '+') {
        continue; // + matches one level
      }
      if (i >= topicParts.length || patternParts[i] !== topicParts[i]) {
        return false;
      }
    }

    return patternParts.length === topicParts.length;
  }

  /**
   * Parse message payload
   */
  private parsePayload(payload: string, sensor: Sensor): Record<string, unknown> | null {
    const format = sensor.protocolConfiguration?.['payloadFormat'] || 'json';

    switch (format) {
      case 'json':
        try {
          return JSON.parse(payload) as Record<string, unknown>;
        } catch {
          this.logger.warn(`Failed to parse JSON payload: ${payload.substring(0, 50)}`);
          return null;
        }

      case 'csv': {
        const parts = payload.split(',');
        const result: Record<string, number> = {};
        parts.forEach((part, index) => {
          const num = parseFloat(part.trim());
          if (!isNaN(num)) {
            result[`value_${index}`] = num;
          }
        });
        return result;
      }

      case 'text': {
        const num = parseFloat(payload.trim());
        if (!isNaN(num)) {
          return { value: num };
        }
        return { raw: payload };
      }

      default:
        try {
          return JSON.parse(payload) as Record<string, unknown>;
        } catch {
          return { raw: payload };
        }
    }
  }

  /**
   * Save sensor reading to database using narrow table format
   * Each channel value becomes a separate row in sensor_metrics
   */
  private async saveReading(sensor: Sensor, data: Record<string, unknown>): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      'sensor',
      sensor.tenantId,
      async (queryRunner) => {
        const now = new Date();
        const channels = await this.getChannelsCached(sensor.id, queryRunner.manager);
        const metrics: SensorMetricInput[] = [];

        for (const channel of channels) {
          const rawValue = channel.dataPath
            ? this.extractValue(data, channel.dataPath)
            : data[channel.channelKey];

          if (rawValue === undefined || rawValue === null) {
            continue;
          }

          const numericRawValue =
            typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue));
          if (!Number.isFinite(numericRawValue)) {
            continue;
          }

          const calibratedValue = channel.applyCalibration(numericRawValue);
          let qualityCode: number = QualityCodes.GOOD;
          let qualityBits = 0;

          const validation = channel.validateValue(calibratedValue);
          if (!validation.valid) {
            qualityCode = QualityCodes.BAD;
            qualityBits |= 0x20; // Out of range bit
          } else if (validation.level === 'operational') {
            qualityCode = QualityCodes.UNCERTAIN_EU_EXCEEDED;
          }

          metrics.push({
            time: now,
            sensorId: sensor.id,
            channelId: channel.id,
            tenantId: sensor.tenantId,
            siteId: sensor.siteId,
            departmentId: sensor.departmentId,
            systemId: sensor.systemId,
            equipmentId: sensor.equipmentId,
            tankId: sensor.tankId,
            pondId: sensor.pondId,
            farmId: sensor.farmId,
            rawValue: numericRawValue,
            value: calibratedValue,
            qualityCode,
            qualityBits,
            sourceProtocol: 'mqtt',
            sourceTimestamp: now,
          });
        }

        if (metrics.length > 0) {
          await this.metricWriter.writeManaged(metrics, queryRunner.manager);
        }

        this.logger.debug(`Saved ${metrics.length} metrics for sensor ${sensor.id}`);
      },
    );
  }

  /**
   * Get channels for a sensor with 60-second cache
   */
  private async getChannelsCached(
    sensorId: string,
    manager: EntityManager,
  ): Promise<SensorDataChannel[]> {
    const cached = this.channelCache.get(sensorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.channels;
    }

    const channels = await tenantManagerRepo(manager, SensorDataChannel).find({
      where: { sensorId, isEnabled: true },
    });

    this.channelCache.set(sensorId, {
      channels,
      expiresAt: Date.now() + this.CHANNEL_CACHE_TTL_MS,
    });

    return channels;
  }

  /**
   * Flush all pending lastSeenAt updates in a single batch
   */
  private async flushLastSeenUpdates(): Promise<void> {
    if (this.lastSeenPending.size === 0) return;

    const entries = Array.from(this.lastSeenPending.entries());
    this.lastSeenPending.clear();

    try {
      // Batch update using a single query with CASE
      const ids = entries.map(([id]) => id);
      await this.sensorRepository
        .createQueryBuilder()
        .update()
        .set({
          lastSeenAt: () => 'NOW()',
          status: SensorStatus.ACTIVE,
        })
        .where('id IN (:...ids)', { ids })
        .execute();

      this.logger.debug(`Flushed lastSeenAt for ${ids.length} sensors`);
    } catch (error) {
      this.logger.error(
        `Failed to flush lastSeenAt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // UUID/finite validation + the sensor.sensor_metrics INSERT are owned by
  // SensorMetricWriterService (SENSOR-MEDIUM-068). saveReading builds
  // SensorMetricInput[] with sourceProtocol 'mqtt' and hands them to
  // writeManaged(metrics, queryRunner.manager). SENSOR-HIGH-085: there is no
  // legacy sensor_readings dual write — the per-reading read surface projects
  // readings from sensor_metrics, so sensor_metrics is the only store.

  /**
   * Extract value from object by path
   */
  private extractValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || typeof current !== 'object') {
        return undefined;
      }
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const key = arrayMatch[1];
        const indexStr = arrayMatch[2];
        if (key && indexStr) {
          const objCurrent = current as Record<string, unknown>;
          const arr = objCurrent[key];
          if (Array.isArray(arr)) {
            current = arr[parseInt(indexStr, 10)];
          } else {
            return undefined;
          }
        }
      } else {
        current = (current as Record<string, unknown>)[part];
      }

      if (current === undefined) {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Get connection status
   */
  isConnectedToBroker(): boolean {
    return this.mqttClient?.isConnectedToBroker() ?? false;
  }

  /**
   * Publish message to topic (for testing)
   */
  async publish(topic: string, message: string | object): Promise<void> {
    if (!this.mqttClient) {
      throw new Error('MQTT client not available');
    }
    await this.mqttClient.publish(topic, message);
  }
}
