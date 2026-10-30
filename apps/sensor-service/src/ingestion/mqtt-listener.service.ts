import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { IEventBus } from '@platform/event-bus';
import { createBaseEvent, deriveEventId, type EventId } from '@platform/event-contracts';
import { DataSource, In } from 'typeorm';

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
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
  tenantManagerRepo,
  TenantScopedRepository,
} from '@aquaculture/backend-common/database';
import { MqttClientService, type MqttMessageFlags } from '../shared-mqtt/mqtt-client.service';
import { SensorServiceProfileService } from '../config/sensor-service-profile.service';

import { ErasedTenantTombstoneService } from '../compliance/erasure/erased-tenant-tombstone.service';
import { VfdEdgeProvisioningService } from '../vfd/services/vfd-edge-provisioning.service';
import { VfdEdgeReadService } from '../vfd/services/vfd-edge-read.service';
import { VfdEdgeWriteService } from '../vfd/services/vfd-edge-write.service';
import { SensorTopicCacheService } from './sensor-topic-cache.service';
import { SensorMetricWriterService } from './sensor-metric-writer.service';
import { SensorPrincipalIngestion } from './sensor-principal-ingestion.service';
import { SensorReadingRecorder } from './sensor-reading-recorder.service';
import { valueAtPath } from './payload-path';
import {
  hasSensorMqttDataShape,
  SENSOR_MQTT_DATA_FILTER,
} from '../mqtt-identity/sensor-mqtt-topic';

/**
 * SENSOR-HIGH-118: the exact topic filters the MQTT listener subscribes.
 *
 * Exported as the SSoT — the sensor_service ACL grants (mqtt-auth.service)
 * and its parameterized unit tests are derived from this list, so the ACL
 * and the subscription set cannot drift apart. One denied filter used to
 * fail the whole single-packet SUBSCRIBE (SUBACK 0x80) and silently kill
 * ALL ingestion.
 */
export const SENSOR_SERVICE_SUBSCRIPTION_FILTERS: readonly string[] = [
  // ADR-047: sensors publishing with their own broker principal, one topic
  // each, written by that sensor alone (the broker ACL).
  SENSOR_MQTT_DATA_FILTER,
  // Sensor data topics (legacy namespaces, SENSOR-HIGH-207)
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

/**
 * Legacy edge/ filters — subscribed only when LEGACY_EDGE_TOPICS_ENABLED.
 * These topics lack tenant enforcement (see D04 SEC-M01 note at the push site).
 */
export const LEGACY_EDGE_SUBSCRIPTION_FILTERS: readonly string[] = [
  'edge/+/heartbeat', // Device heartbeat (health metrics)
  'edge/+/birth', // Device birth certificate
  'edge/+/death', // Device death (LWT - Last Will Testament)
  'edge/+/response', // Command response from device (legacy singular)
  'edge/+/responses', // Command response from device (plural - Edge Agent v2.0+)
];

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
 * Marks a failure of the DURABLE leg of message handling: resolving the
 * reading's sensor, then the one tenant transaction that writes the metric
 * rows AND enqueues the reading's SensorReading into the transactional
 * outbox. Only these propagate out of handleMessage: a reading whose rows or
 * dispatch obligation did not commit must not be PUBACKed — the MQTT ack gate
 * force-redelivers it from the persistent session (SENSOR-CRITICAL-086,
 * SENSOR-CRITICAL-190, SENSOR-CRITICAL-191). A failed lookup belongs here, not
 * with "no sensor": a PostgreSQL failover reaches the per-message sensor
 * reload before it reaches the write. The fan-out itself is no longer a
 * failure mode here: the outbox relay publishes the committed row. Parse
 * failures stay ack-and-drop until the Task 1.6 disposition/DLQ contract
 * classifies them (SENSOR-HIGH-093).
 *
 * Because every throw inside the leg holds PUBACK and reconnects the ONE
 * shared MQTT connection, the code that runs there on device-controlled input
 * is total: it never throws on a payload's shape (the identity digest hashes
 * the wire bytes, an unparseable ts falls back to the receive time, and a
 * non-scalar channel value is skipped).
 */
class DurableWriteError extends Error {}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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
  // Promise-typed on purpose: the ack gate settles PUBACK on this promise.
  private readonly messageHandler: (
    topic: string,
    message: Buffer,
    flags: MqttMessageFlags,
  ) => Promise<void>;

  // When each sensor channel ("sensorId:channelId") last warned that a
  // non-scalar value was skipped: one warn line an hour, not one per message.
  private readonly nonScalarWarnedAt = new Map<string, number>();
  private readonly NON_SCALAR_WARN_INTERVAL_MS = 3_600_000;

  // Cache for device lookups (tenantId:deviceCode -> device entity)
  private readonly deviceCache = new Map<string, { device: EdgeDevice; expiry: number }>();
  // Cache for io configs (deviceId -> ioConfigs[])
  private readonly ioConfigCache = new Map<string, { configs: DeviceIoConfig[]; expiry: number }>();
  private readonly DEVICE_CACHE_TTL_MS = 30_000; // 30 seconds

  // lastSeenAt debounce: sensorId -> owning tenantId. The flush writes each
  // tenant's sensors inside that tenant's RLS context (SENSOR-HIGH-137), so
  // the owner travels with the id.
  private readonly lastSeenPending = new Map<string, string>();
  private lastSeenFlushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly LAST_SEEN_FLUSH_INTERVAL_MS = 30_000; // 30 seconds

  // Legacy edge/ topic support (D04 SEC-M01)
  // Set LEGACY_EDGE_TOPICS_ENABLED=false to disable legacy edge/{deviceCode}/... topics
  // and force all devices to use tenant-prefixed tenants/{tenantId}/devices/{deviceCode}/... pattern
  private readonly legacyEdgeTopicsEnabled: boolean;

  // ADR-022 + ADR-047 §4: on the control-plane profile the Rust sidecar owns
  // the legacy sensor and edge topics, but not tenants/+/sensors/+/data —
  // the sidecar cannot take that topic until it has a broker principal on the
  // production listener and a lookup that carries the registration status.
  // So the listener stays up for that one route. Set at boot.
  private principalRouteOnly = false;

  // MQTT payload size limit (D04 SEC-L02)
  // Reject messages larger than 256KB to prevent memory abuse
  private static readonly MAX_PAYLOAD_SIZE = 256 * 1024; // 256KB

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly metricWriter: SensorMetricWriterService,
    // SENSOR-CRITICAL-191: a reading's metric rows and its SensorReading
    // outbox row are written in ONE tenant transaction by the recorder, and
    // the outbox relay owns the NATS delivery — the one post-commit delivery
    // owner sensor-service has (SENSOR-CRITICAL-001). Required, never
    // optional: without it there is no durable dispatch and the ack gate would
    // release PUBACK for an event nothing will retry.
    private readonly recorder: SensorReadingRecorder,
    // ADR-047 §4: tenants/+/sensors/+/data, the topic only a sensor's own
    // broker principal publishes to.
    private readonly principalIngestion: SensorPrincipalIngestion,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
    @Optional()
    @Inject(EdgeDeviceService)
    private readonly edgeDeviceService: EdgeDeviceService | null,
    // SENSOR-HIGH-137: the topic cache is the ONLY topic→sensor resolver. The
    // former "legacy" cross-schema fallback ran when this was null and read
    // tenant schemas with search_path alone, which FORCE RLS answers with zero
    // rows — a second, silently blind resolution path. Required, not optional.
    private readonly sensorTopicCache: SensorTopicCacheService,
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
    // Task 1.8: erased-tenant tombstone — trailing optional so the
    // `new`-based unit-test harness (positional args) stays untouched. The
    // explicit token is load-bearing: a `T | null` parameter is emitted as
    // `Object` in design:paramtypes, so without it Nest resolved no provider,
    // @Optional() passed undefined, and the gate was null in every boot.
    @Optional()
    @Inject(ErasedTenantTombstoneService)
    private readonly tombstone: ErasedTenantTombstoneService | null = null,
  ) {
    // Legacy edge/ topic flag (default: true for backward compatibility)
    this.legacyEdgeTopicsEnabled =
      this.configService.get('LEGACY_EDGE_TOPICS_ENABLED', 'true') === 'true';

    // Bind message handler to this instance. The promise is RETURNED and a
    // rejection is RETHROWN after it is counted: MqttClientService's ack gate
    // (dispatchDurable) awaits this promise to decide PUBACK-vs-redelivery
    // (SENSOR-CRITICAL-086). A `.catch` that only counts turns the rejection
    // into a resolved promise, and the gate then acks a reading that was never
    // persisted (SENSOR-CRITICAL-190).
    this.messageHandler = (
      topic: string,
      message: Buffer,
      flags: MqttMessageFlags,
    ): Promise<void> => {
      this.mqttClient?.recordMessageReceived();
      return this.handleMessage(topic, message, flags).then(
        () => {
          this.mqttClient?.recordMessageProcessed();
        },
        (error: unknown) => {
          this.mqttClient?.recordMessageFailed();
          throw error;
        },
      );
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
    this.principalRouteOnly = this.profile !== null && !this.profile.isLegacyDataPlaneEnabled();
    if (this.principalRouteOnly) {
      this.logger.log(
        'SENSOR_SERVICE_PROFILE=control-plane: the Rust sidecar owns the legacy and edge topics; ' +
          'the listener subscribes the sensor data filter alone (ADR-047 §4).',
      );
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

    // Subscribe to wildcard topic patterns (SENSOR_SERVICE_SUBSCRIPTION_FILTERS
    // is the single source of truth — the ACL grant list and its unit tests
    // are derived from it, see SENSOR-HIGH-118).
    if (this.principalRouteOnly) {
      try {
        await this.mqttClient.subscribe([SENSOR_MQTT_DATA_FILTER]);
      } catch (error) {
        this.logger.warn(`Failed to subscribe to topics: ${(error as Error).message}`);
      }
      return;
    }
    const topics = [...SENSOR_SERVICE_SUBSCRIPTION_FILTERS];

    // Legacy edge/ topics (D04 SEC-M01): only subscribe when explicitly enabled
    // These topics lack tenant enforcement — migrate devices to tenant-prefixed topics
    if (this.legacyEdgeTopicsEnabled) {
      topics.push(...LEGACY_EDGE_SUBSCRIPTION_FILTERS);
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
  private async handleMessage(
    topic: string,
    message: Buffer,
    flags: MqttMessageFlags,
  ): Promise<void> {
    try {
      // D04 SEC-L02: Reject oversized payloads before any processing
      if (message.length > MqttListenerService.MAX_PAYLOAD_SIZE) {
        this.logger.warn(
          `Payload too large: ${message.length} bytes from topic ${topic} ` +
            `(limit: ${MqttListenerService.MAX_PAYLOAD_SIZE} bytes). Message dropped.`,
        );
        return;
      }

      // ADR-047 §4: a sensor's own data topic is routed before any edge
      // handler (it shares the tenants/ prefix) and never reaches the legacy
      // topic scan. Its tombstone, retain, rate, size and schema checks run
      // in the route; a database failure there holds PUBACK.
      if (hasSensorMqttDataShape(topic)) {
        const disposition = await this.principalIngestion
          .handle(topic, message, flags)
          .catch((error: Error) => {
            throw new DurableWriteError(
              `Durable write failed for sensor data topic ${topic}: ${error.message}`,
            );
          });
        if (disposition.kind === 'recorded') {
          this.lastSeenPending.set(disposition.sensorId, disposition.tenantId);
        }
        return;
      }

      // Control-plane profile: the sidecar consumes every other topic. A
      // message for one still reaching this persistent session (a
      // subscription left from a legacy-profile run) is not consumed twice.
      if (this.principalRouteOnly) {
        this.logger.debug(
          `Control-plane profile: ${topic} belongs to the sidecar, not consumed here`,
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

      // Resolve the owning sensor (tenant-scoped reload, SENSOR-HIGH-137)
      const sensor = await this.findSensorByTopic(topic);

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

      const receivedAt = new Date();
      // Task 1.4 identity, from the raw wire bytes: a redelivery of the SAME
      // wire message derives the same eventId, which the outbox's
      // (tenantId, idempotencyKey) index collapses onto the row already
      // committed.
      const eventId = this.deriveLegacyReadingEventId(sensor, data, message, receivedAt);

      // Save the reading AND its dispatch obligation in one tenant
      // transaction. A failure here means the rows or the SensorReading's
      // outbox row did NOT commit — it must propagate (wrapped in
      // DurableWriteError) so the MQTT ack gate holds PUBACK and the
      // persistent session redelivers (SENSOR-CRITICAL-086/-191). Once this
      // returns, both are durable and the outbox relay owns the publish.
      await this.saveReading(sensor, data, eventId, receivedAt).catch((error: Error) => {
        throw new DurableWriteError(
          `Durable metric write failed for sensor ${sensor.id}: ${error.message}`,
        );
      });

      // Debounce lastSeenAt update (flushed every 30 seconds)
      this.lastSeenPending.set(sensor.id, sensor.tenantId);
    } catch (error) {
      if (error instanceof DurableWriteError) {
        // Not durable → no ack → redelivery. The ack gate in
        // MqttClientService.forceRedelivery owns the reconnect.
        throw error;
      }
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
   * Deterministic identity for the legacy MQTT path (plan Task 1.4):
   * tenant + sensor + producer timestamp + SHA-256 of the wire bytes. The
   * producer ts prefers the payload's own `ts`/`timestamp`/`producerTs`
   * field; the receive time is the fallback (documented limitation: a
   * redelivered legacy payload without a usable ts of its own gets a fresh
   * receive-time identity — the edge-assigned sourceEventId removes that
   * ambiguity, SENSOR-MEDIUM-195).
   *
   * Total over any payload: the caller derives it before the durable leg,
   * and nothing here can throw on a payload's shape.
   */
  private deriveLegacyReadingEventId(
    sensor: Sensor,
    data: Record<string, unknown>,
    wire: Buffer,
    receivedAt: Date,
  ): EventId {
    const producerTs = this.extractProducerTs(data) ?? receivedAt.toISOString();
    // The digest is over the bytes the broker delivered, not a re-rendering
    // of the parsed payload: a redelivery repeats those bytes exactly, and
    // hashing them cannot throw. The recursive canonical rendering this
    // replaces overflowed the stack on a deeply nested payload.
    const payloadSha = sha256Hex(wire);
    return deriveEventId([sensor.tenantId, sensor.id, producerTs, payloadSha].join('\u0000'));
  }

  /** The payload's own timestamp as ISO-8601, or null when it has none a Date can hold. */
  private extractProducerTs(data: Record<string, unknown>): string | null {
    for (const key of ['ts', 'timestamp', 'producerTs']) {
      const raw = data[key];
      if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.length === 0)) {
        continue;
      }
      // A number outside +/-8.64e15 ms (a nanosecond epoch, say) is as
      // unusable as an unparseable string: the Date is invalid, and
      // toISOString() would throw RangeError on it.
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    return null;
  }

  /**
   * Resolve the sensor that owns an MQTT topic.
   *
   * SensorTopicCacheService maps topic → {tenantId, sensorId} (local cache →
   * Redis → per-tenant runInTenantRead scan). The full entity is then reloaded
   * inside the OWNING tenant's read boundary: tenant schemas carry FORCE RLS
   * and the pool is deny-by-default outside a tenant context, so a reload with
   * only search_path pinned sees zero rows (SENSOR-HIGH-137 — every MQTT
   * reading was dropped at debug level from 2026-09-19 23:55Z).
   *
   * null means the lookup FOUND no sensor, or found one whose tenant is
   * erased or gone; the gate then acks and drops the reading. A lookup that
   * FAILED rejects with DurableWriteError instead: the reading was never
   * persisted, so the ack gate must hold PUBACK (SENSOR-CRITICAL-190) — the
   * reload runs on every message, so a PostgreSQL failover fails here before
   * it reaches the write. The resolver's own swallow-and-negative-cache of a
   * per-tenant read error is SENSOR-HIGH-196; a reload that fails the same
   * way on every attempt for a LIVE tenant is SENSOR-HIGH-197.
   */
  private async findSensorByTopic(topic: string): Promise<Sensor | null> {
    const lookupFailed = (error: unknown): never => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new DurableWriteError(`Sensor lookup failed for topic ${topic}: ${reason}`);
    };

    const cachedInfo = await this.sensorTopicCache.getSensorByTopic(topic).catch(lookupFailed);
    if (!cachedInfo) {
      return null;
    }

    // Task 1.8 (erasure tombstone), asked of the mapping before anything
    // reads the tenant's schema: an erased tenant's late messages are
    // ACK-dropped. Persisting them would recreate the just-erased data and
    // enqueue a fresh outbox row (Swiss-cheese erasure), and once the erasure
    // has dropped the schema a reload could only fail.
    if (this.tombstone?.isErased(cachedInfo.tenantId)) {
      this.logger.warn(
        `ACK-drop for erased tenant on topic ${topic} — message discarded without persistence`,
      );
      return null;
    }

    let sensor: Sensor | null;
    try {
      sensor = await runInTenantRead(
        this.dataSource,
        SENSOR_SOURCE_SCHEMA,
        cachedInfo.tenantId,
        (qr) => tenantManagerRepo(qr.manager, Sensor).findOne({ where: { id: cachedInfo.id } }),
      );
    } catch (reloadError) {
      // A mapping outlives its tenant: one cached before db-migrate's delete
      // job (deprovision or erasure) dropped the schema keeps resolving for
      // up to an hour, and every reload through it fails the tenant boundary
      // (SCHEMA_MISMATCH). Holding PUBACK on that would reconnect-loop the
      // one shared connection for every tenant and can never succeed, so a
      // failed reload of a tenant the platform no longer lists as active is
      // "found nothing": its mappings are evicted and the reading dropped. A
      // live tenant's failed reload, or one whose liveness cannot be read,
      // stays a lookup failure and is redelivered.
      const tenantGone = await this.sensorTopicCache
        .evictIfTenantInactive(cachedInfo.tenantId)
        .catch(() => lookupFailed(reloadError));
      if (!tenantGone) {
        return lookupFailed(reloadError);
      }
      this.logger.warn(
        `Topic ${topic} maps to tenant ${cachedInfo.tenantId}, which is no longer active — ` +
          "reading dropped, the tenant's topic mappings evicted",
      );
      return null;
    }

    if (!sensor) {
      // The resolver named a sensor its own tenant cannot read back: a stale
      // cache entry (sensor deleted) or a broken read boundary. Either way
      // readings are being lost, so this is an error, not a debug line —
      // and the stale mapping is evicted so the next message re-resolves.
      this.logger.error(
        `Topic ${topic} resolved to sensor ${cachedInfo.id} (tenant ${cachedInfo.tenantId}) ` +
          'but the tenant-scoped reload returned no row — reading dropped, topic mapping evicted',
      );
      await this.sensorTopicCache.invalidateSensor(cachedInfo.id, cachedInfo.tenantId);
    }
    return sensor;
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
   * Make a skipped non-scalar channel value visible. Before the durable leg
   * was made total, String() coerced a one-element array such as [23.5] to
   * "23.5" and the reading was stored; now the channel is skipped, and a
   * device that sends that shape would lose every reading with no other
   * signal than a debug "Saved 0 metrics". Names the dataPath remedy, and
   * never renders the value (a deep one is what made String() throw).
   */
  private warnNonScalarChannel(sensor: Sensor, channel: SensorDataChannel): void {
    const key = `${sensor.id}:${channel.id}`;
    const now = Date.now();
    const lastWarnedAt = this.nonScalarWarnedAt.get(key);
    if (lastWarnedAt !== undefined && now - lastWarnedAt < this.NON_SCALAR_WARN_INTERVAL_MS) {
      return;
    }
    this.nonScalarWarnedAt.set(key, now);
    const path = channel.dataPath || channel.channelKey;
    this.logger.warn(
      `Sensor ${sensor.id} channel ${channel.channelKey}: non-scalar value (array or object) ` +
        `skipped, no reading stored. If the number is inside it, point the channel at it, ` +
        `e.g. dataPath "${path}[0]". Repeats are not logged for an hour.`,
    );
  }

  /**
   * Save a legacy-topic reading: its metric rows and its SensorReading outbox
   * row in ONE tenant transaction (SensorReadingRecorder), so both commit or
   * neither (SENSOR-CRITICAL-191). When this resolves the reading and its
   * dispatch obligation are durable, which is what lets the ack gate release
   * PUBACK. A channel value here is a number or a numeric string; a
   * non-scalar value is skipped and the skip is logged.
   */
  private async saveReading(
    sensor: Sensor,
    data: Record<string, unknown>,
    eventId: EventId,
    receivedAt: Date,
  ): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      sensor.tenantId,
      async (queryRunner) => {
        await this.recorder.record(queryRunner.manager, {
          sensor,
          sampledAt: receivedAt,
          eventId,
          valueOf: (channel) => this.legacyValueOf(sensor, data, channel),
        });
      },
    );
  }

  /**
   * A channel's value on a legacy topic: a number or a numeric string. String()
   * of an array or object recursed through the device's nesting and threw
   * RangeError on a deep one, inside the write transaction; a non-scalar value
   * is skipped like a non-finite one, and the skip is logged.
   */
  private legacyValueOf(
    sensor: Sensor,
    data: Record<string, unknown>,
    channel: SensorDataChannel,
  ): number | undefined {
    const rawValue = channel.dataPath
      ? valueAtPath(data, channel.dataPath)
      : data[channel.channelKey];
    if (rawValue === undefined || rawValue === null) {
      return undefined;
    }
    if (typeof rawValue === 'object') {
      this.warnNonScalarChannel(sensor, channel);
      return undefined;
    }
    const numeric =
      typeof rawValue === 'number'
        ? rawValue
        : typeof rawValue === 'string'
          ? parseFloat(rawValue)
          : Number.NaN;
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  /**
   * Flush pending lastSeenAt updates — one statement per owning tenant, each
   * inside that tenant's RLS boundary. A tenant-agnostic UPDATE through the
   * pool matches zero rows under FORCE RLS (SENSOR-HIGH-137), which is why
   * sensors that were ingesting still showed last_seen_at = NULL.
   */
  private async flushLastSeenUpdates(): Promise<void> {
    if (this.lastSeenPending.size === 0) return;

    const byTenant = new Map<string, string[]>();
    for (const [sensorId, tenantId] of this.lastSeenPending) {
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), sensorId]);
    }
    this.lastSeenPending.clear();

    const seenAt = new Date();
    for (const [tenantId, ids] of byTenant) {
      try {
        await runInTenantTransaction(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, (qr) =>
          tenantManagerRepo(qr.manager, Sensor).update(
            { id: In(ids) },
            { lastSeenAt: seenAt, status: SensorStatus.ACTIVE },
          ),
        );
        this.logger.debug(`Flushed lastSeenAt for ${ids.length} sensors of tenant ${tenantId}`);
      } catch (error) {
        this.logger.error(
          `Failed to flush lastSeenAt for tenant ${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  // UUID/finite validation + the sensor.sensor_metrics INSERT are owned by
  // SensorMetricWriterService (SENSOR-MEDIUM-068). saveReading builds
  // SensorMetricInput[] with sourceProtocol 'mqtt' and hands them to
  // writeManaged(metrics, queryRunner.manager). SENSOR-HIGH-085: there is no
  // legacy sensor_readings dual write — the per-reading read surface projects
  // readings from sensor_metrics, so sensor_metrics is the only store.

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
