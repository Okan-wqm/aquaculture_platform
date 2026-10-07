import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  listActiveTenantSchemaIdentities,
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { IEventBus } from '@platform/event-bus';
import {
  createBaseEvent,
  projectPersistedReadings,
  type PersistedReadingMetric,
} from '@platform/event-contracts';
import { DataSource, In } from 'typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { QualityCodes, SensorMetricInput } from '../database/entities/sensor-metric.entity';
import { Sensor, SensorStatus, SensorRegistrationStatus } from '../database/entities/sensor.entity';
import { SensorServiceProfileService } from '../config/sensor-service-profile.service';
import {
  ConnectionHandle,
  DataSubscription,
  SensorReadingData,
} from '../protocol/adapters/base-protocol.adapter';
import { MqttAdapter, MqttConfiguration } from '../protocol/adapters/iot/mqtt.adapter';
import { SensorMetricWriterService } from './sensor-metric-writer.service';

/**
 * Active sensor connection info
 */
interface ActiveConnection {
  sensor: Sensor;
  handle: ConnectionHandle;
  subscription: DataSubscription;
  lastReadingAt?: Date;
  errorCount: number;
}

/**
 * Data Ingestion Service
 * Manages active sensor connections and writes readings to database
 *
 * Every read and write of `sensors` / `sensor_data_channels` runs inside the
 * owning tenant's RLS boundary (runInTenantRead / runInTenantTransaction):
 * both tables are FORCE-RLS per tenant and this service runs outside any
 * request, so a bare repository call matches no row (SENSOR-HIGH-148). The
 * boot scan walks the active tenants through the platform mapping instead of
 * one cross-tenant query.
 */
@Injectable()
export class DataIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataIngestionService.name);
  private readonly activeConnections = new Map<string, ActiveConnection>();
  private readonly mqttAdapter: MqttAdapter;
  private isShuttingDown = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  // Channel lookup cache: sensorId -> { tenantId, channels, expiresAt }. The
  // tenant is part of the entry so a hit is only ever served to its tenant.
  private readonly channelCache = new Map<
    string,
    { tenantId: string; channels: SensorDataChannel[]; expiresAt: number }
  >();
  private readonly CHANNEL_CACHE_TTL_MS = 60_000; // 60 seconds

  // lastSeenAt debounce: sensorId -> its tenant (flushed per tenant)
  private readonly lastSeenPending = new Map<string, string>();
  private lastSeenFlushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly LAST_SEEN_FLUSH_INTERVAL_MS = 30_000; // 30 seconds

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly metricWriter: SensorMetricWriterService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
    // ADR-022: profile is optional so existing test harnesses (which
    // construct via `new`) keep working — falls back to legacy
    // behaviour when missing.
    @Optional()
    @Inject(SensorServiceProfileService)
    private readonly profile: SensorServiceProfileService | null = null,
  ) {
    this.mqttAdapter = new MqttAdapter(configService);
  }

  async onModuleInit(): Promise<void> {
    // ADR-022: control-plane profile delegates the data path to the
    // Rust ingestion sidecar (ADR-025); skip per-sensor connection
    // boot here so we do not double-consume MQTT QoS-1 messages.
    if (this.profile && !this.profile.isLegacyDataPlaneEnabled()) {
      this.logger.log(
        'SENSOR_SERVICE_PROFILE=control-plane: DataIngestionService skipping per-sensor connection boot.',
      );
      return;
    }
    this.logger.log('Initializing Data Ingestion Service...');

    // Start connecting to active sensors
    await this.startAllActiveSensors();

    // Start health check interval
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck().catch((error: Error) => {
        this.logger.error(`Health check failed: ${error.message}`, error.stack);
      });
    }, 30000); // Every 30 seconds

    // Start lastSeenAt flush timer (debounce per-message updates)
    this.lastSeenFlushTimer = setInterval(() => {
      this.flushLastSeenUpdates().catch((err) => {
        this.logger.error(
          `Failed to flush lastSeenAt updates: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.LAST_SEEN_FLUSH_INTERVAL_MS);

    this.logger.log(
      `Data Ingestion Service initialized with ${this.activeConnections.size} active connections`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down Data Ingestion Service...');
    this.isShuttingDown = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Flush pending lastSeenAt updates before shutdown
    if (this.lastSeenFlushTimer) {
      clearInterval(this.lastSeenFlushTimer);
      this.lastSeenFlushTimer = null;
    }
    await this.flushLastSeenUpdates();

    // Disconnect all active sensors
    await this.stopAllSensors();

    this.logger.log('Data Ingestion Service shut down');
  }

  /**
   * Start data collection for all active sensors
   */
  async startAllActiveSensors(): Promise<void> {
    try {
      const tenants = await listActiveTenantSchemaIdentities(this.dataSource);
      for (const { tenantId } of tenants) {
        // Active MQTT parent sensors of this tenant, inside its boundary.
        const activeSensors = await runInTenantRead(
          this.dataSource,
          SENSOR_SOURCE_SCHEMA,
          tenantId,
          (qr) =>
            tenantManagerRepo(qr.manager, Sensor).find({
              where: {
                registrationStatus: SensorRegistrationStatus.ACTIVE,
                isActive: true,
                isParentDevice: true,
                protocol: { code: 'MQTT' },
              },
              relations: ['protocol'],
            }),
        );

        this.logger.log(`Found ${activeSensors.length} active MQTT parent sensors in a tenant`);

        for (const sensor of activeSensors) {
          try {
            await this.startSensorDataCollection(sensor);
          } catch (error) {
            this.logger.error(
              `Failed to start data collection for sensor ${sensor.id}: ${(error as Error).message}`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(`Failed to start active sensors: ${(error as Error).message}`);
    }
  }

  /** Update one sensor row inside its tenant's boundary. */
  private async updateSensor(
    sensor: Pick<Sensor, 'id' | 'tenantId'>,
    changes: Partial<Pick<Sensor, 'status' | 'lastSeenAt'>>,
  ): Promise<void> {
    await runInTenantTransaction(this.dataSource, SENSOR_SOURCE_SCHEMA, sensor.tenantId, (qr) =>
      tenantManagerRepo(qr.manager, Sensor).update({ id: sensor.id }, changes),
    );
  }

  /** Re-read a sensor (with its protocol) inside its tenant's boundary. */
  private async reloadSensor(sensorId: string, tenantId: string): Promise<Sensor | null> {
    return runInTenantRead(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, (qr) =>
      tenantManagerRepo(qr.manager, Sensor).findOne({
        where: { id: sensorId },
        relations: ['protocol'],
      }),
    );
  }

  /**
   * Start data collection for a single sensor
   */
  async startSensorDataCollection(sensor: Sensor): Promise<void> {
    if (this.activeConnections.has(sensor.id)) {
      this.logger.warn(`Sensor ${sensor.id} is already connected`);
      return;
    }

    if (!sensor.protocolConfiguration) {
      this.logger.warn(`Sensor ${sensor.id} has no protocol configuration`);
      return;
    }

    const config = {
      ...sensor.protocolConfiguration,
      sensorId: sensor.id,
      tenantId: sensor.tenantId,
    };

    try {
      this.logger.log(`Connecting to sensor ${sensor.id} (${sensor.name})...`);

      // Connect to the sensor
      const handle = await this.mqttAdapter.connect(config as MqttConfiguration);

      // Subscribe to data
      const subscription = await this.mqttAdapter.subscribeToData(
        handle,
        (data) => {
          void this.handleSensorData(sensor, data);
        },
        (error) => {
          void this.handleSensorError(sensor, error);
        },
      );

      // Store active connection
      this.activeConnections.set(sensor.id, {
        sensor,
        handle,
        subscription,
        errorCount: 0,
      });

      // Update sensor status
      await this.updateSensor(sensor, {
        status: SensorStatus.ACTIVE,
        lastSeenAt: new Date(),
      });

      this.logger.log(`Successfully connected to sensor ${sensor.id}`);
    } catch (error) {
      this.logger.error(`Failed to connect to sensor ${sensor.id}: ${(error as Error).message}`);

      // Update sensor status to error
      await this.updateSensor(sensor, {
        status: SensorStatus.ERROR,
      });

      throw error;
    }
  }

  /**
   * Stop data collection for a sensor
   */
  async stopSensorDataCollection(sensorId: string): Promise<void> {
    const connection = this.activeConnections.get(sensorId);
    if (!connection) {
      return;
    }

    try {
      // Unsubscribe
      await connection.subscription.unsubscribe();

      // Disconnect
      await this.mqttAdapter.disconnect(connection.handle);

      // Remove from active connections
      this.activeConnections.delete(sensorId);

      this.logger.log(`Stopped data collection for sensor ${sensorId}`);
    } catch (error) {
      this.logger.error(`Error stopping sensor ${sensorId}: ${(error as Error).message}`);
    }
  }

  /**
   * Stop all sensor connections
   */
  async stopAllSensors(): Promise<void> {
    const sensorIds = Array.from(this.activeConnections.keys());

    for (const sensorId of sensorIds) {
      await this.stopSensorDataCollection(sensorId);
    }
  }

  /**
   * Handle incoming sensor data
   * Uses narrow table format (sensor_metrics) for optimal performance
   * Each channel value becomes a separate row
   */
  private async handleSensorData(sensor: Sensor, data: SensorReadingData): Promise<void> {
    try {
      const connection = this.activeConnections.get(sensor.id);
      if (connection) {
        connection.lastReadingAt = new Date();
        connection.errorCount = 0;
      }

      const now = new Date();
      const sourceTimestamp = data.timestamp || now;
      const ingestionLatencyMs = now.getTime() - sourceTimestamp.getTime();

      // Get all channels for this sensor (cached — 60-second TTL)
      const channels = await this.getChannelsCached(sensor.id, sensor.tenantId);

      // Collect metrics for batch insert
      const metrics: SensorMetricInput[] = [];
      const persisted: PersistedReadingMetric[] = [];

      for (const channel of channels) {
        // Extract value using dataPath
        const rawValue = channel.dataPath
          ? this.extractValueByPath(data.values, channel.dataPath)
          : data.values[channel.channelKey];

        if (rawValue === undefined || rawValue === null) {
          continue;
        }

        // Convert to number
        const numericRawValue =
          typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue));
        if (isNaN(numericRawValue)) {
          continue;
        }

        // Apply calibration
        const calibratedValue = channel.applyCalibration(numericRawValue);

        // Determine quality code
        let qualityCode: number = QualityCodes.GOOD;
        let qualityBits = 0;

        // Check physical bounds
        const validation = channel.validateValue(calibratedValue);
        if (!validation.valid) {
          qualityCode = QualityCodes.BAD;
          qualityBits |= 0x20; // Out of range bit
        } else if (validation.level === 'operational') {
          qualityCode = QualityCodes.UNCERTAIN_EU_EXCEEDED;
        }

        // Create metric entry
        metrics.push({
          time: sourceTimestamp,
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
          sourceProtocol: data.source || 'mqtt',
          sourceTimestamp,
        });

        // SENSOR-CRITICAL-111: captured here because the metric row carries the
        // channel UUID while the projection needs the device-facing key.
        persisted.push({
          channelKey: channel.channelKey,
          value: calibratedValue,
          farmId: sensor.farmId,
          pondId: sensor.pondId,
          tankId: sensor.tankId,
        });
      }

      // Persist all metrics via the single sensor.sensor_metrics writer.
      // SENSOR-HIGH-085: sensor_metrics is the ONLY store — the per-reading read
      // surface projects readings from it, so there is no sensor_readings dual
      // write to keep in sync.
      if (metrics.length > 0) {
        await this.metricWriter.writeImmediate(metrics);
      }

      // Publish SensorReading NATS event so alert-engine can evaluate this data path.
      // SENSOR-CRITICAL-111: projected from the rows just written, never from
      // `data.values` — that carried the pre-calibration wire numbers and no
      // farm/pond/tank, so the alert engine evaluated a value the platform had
      // not stored, under a scope that excluded every farm-scoped rule.
      const projection = projectPersistedReadings(persisted);
      if (this.eventBus && projection.mappedCount > 0) {
        try {
          await this.eventBus.publish({
            ...createBaseEvent('SensorReading', sensor.tenantId, {
              aggregateId: sensor.id,
              aggregateType: 'Sensor',
            }),
            eventType: 'SensorReading' as const,
            timestamp: sourceTimestamp.toISOString(),
            sensorId: sensor.id,
            ...projection.fields,
            ...(projection.farmId !== undefined ? { farmId: projection.farmId } : {}),
            ...(projection.pondId !== undefined ? { pondId: projection.pondId } : {}),
            ...(projection.tankId !== undefined ? { tankId: projection.tankId } : {}),
            ...(projection.parameter !== undefined ? { parameter: projection.parameter } : {}),
          });
        } catch (error) {
          this.logger.warn(`Failed to publish SensorReading event: ${(error as Error).message}`);
        }
      } else if (this.eventBus && metrics.length > 0) {
        // Rows were stored but none is in the flat reading vocabulary. An empty
        // reading is not a harmless no-op downstream: the alert engine treats it
        // as "nothing is wrong" and auto-resolves open INFO/LOW incidents.
        this.logger.debug(
          `Sensor ${sensor.id}: ${metrics.length} metric(s) stored, none in the reading vocabulary — no SensorReading published`,
        );
      }

      // Debounce lastSeenAt update — flushed in batch every 30 seconds
      this.lastSeenPending.set(sensor.id, sensor.tenantId);

      this.logger.debug(
        `Processed ${metrics.length} metrics from sensor ${sensor.id} (latency: ${ingestionLatencyMs}ms)`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing data from sensor ${sensor.id}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get channels for a sensor with 60-second in-memory cache
   */
  private async getChannelsCached(
    sensorId: string,
    tenantId: string,
  ): Promise<SensorDataChannel[]> {
    const cached = this.channelCache.get(sensorId);
    if (cached && cached.tenantId === tenantId && cached.expiresAt > Date.now()) {
      return cached.channels;
    }

    const channels = await runInTenantRead(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, (qr) =>
      tenantManagerRepo(qr.manager, SensorDataChannel).find({
        where: { sensorId, isEnabled: true },
      }),
    );

    this.channelCache.set(sensorId, {
      tenantId,
      channels,
      expiresAt: Date.now() + this.CHANNEL_CACHE_TTL_MS,
    });

    return channels;
  }

  /**
   * Flush all pending lastSeenAt updates: one statement per tenant, each
   * inside that tenant's boundary.
   */
  private async flushLastSeenUpdates(): Promise<void> {
    if (this.lastSeenPending.size === 0) return;

    const byTenant = new Map<string, string[]>();
    for (const [sensorId, tenantId] of this.lastSeenPending) {
      const ids = byTenant.get(tenantId);
      if (ids) ids.push(sensorId);
      else byTenant.set(tenantId, [sensorId]);
    }
    this.lastSeenPending.clear();

    for (const [tenantId, ids] of byTenant) {
      try {
        await runInTenantTransaction(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, (qr) =>
          tenantManagerRepo(qr.manager, Sensor).update(
            { id: In(ids) },
            { lastSeenAt: new Date(), status: SensorStatus.ACTIVE },
          ),
        );
        this.logger.debug(`Flushed lastSeenAt for ${ids.length} sensors`);
      } catch (error) {
        this.logger.error(
          `Failed to flush lastSeenAt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Metric persistence (UUID/finite validation + the sensor.sensor_metrics
  // INSERT) is owned by SensorMetricWriterService (SENSOR-MEDIUM-068). There is
  // no legacy sensor_readings write — the per-reading read surface projects from
  // sensor_metrics (SENSOR-HIGH-085).

  /**
   * Handle sensor errors
   */
  private async handleSensorError(sensor: Sensor, error: Error): Promise<void> {
    this.logger.error(`Sensor ${sensor.id} error: ${error.message}`);

    const connection = this.activeConnections.get(sensor.id);
    if (connection) {
      connection.errorCount++;

      // Log the error
      this.logger.warn(`Sensor ${sensor.id} error count: ${connection.errorCount}`);

      // If too many errors, try to reconnect
      if (connection.errorCount >= 5) {
        this.logger.warn(
          `Sensor ${sensor.id} has ${connection.errorCount} errors, attempting reconnect...`,
        );

        await this.stopSensorDataCollection(sensor.id);

        // Wait a bit before reconnecting
        setTimeout(() => {
          void (async () => {
            if (!this.isShuttingDown) {
              try {
                const freshSensor = await this.reloadSensor(sensor.id, sensor.tenantId);
                if (freshSensor) {
                  await this.startSensorDataCollection(freshSensor);
                }
              } catch (reconnectError) {
                this.logger.error(
                  `Failed to reconnect sensor ${sensor.id}: ${(reconnectError as Error).message}`,
                );
              }
            }
          })();
        }, 5000);
      }
    }
  }

  /**
   * Extract value from nested object by path
   * e.g., "data.temperature" or "sensors[0].value"
   */
  private extractValueByPath(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      // Handle array notation like "sensors[0]"
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const key = arrayMatch[1];
        const indexStr = arrayMatch[2];
        if (key && indexStr) {
          const obj = current as Record<string, unknown> | undefined;
          const arr = obj?.[key] as unknown[] | undefined;
          current = arr?.[parseInt(indexStr, 10)];
        }
      } else {
        current = (current as Record<string, unknown> | undefined)?.[part];
      }

      if (current === undefined) {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Perform health check on all connections
   */
  private async performHealthCheck(): Promise<void> {
    if (this.isShuttingDown) return;

    const now = Date.now();
    const staleThreshold = 30 * 1000; // 30 seconds - faster detection for sensor issues

    // Create a snapshot of entries to avoid concurrent modification during iteration
    const connectionEntries = Array.from(this.activeConnections.entries());

    for (const [sensorId, connection] of connectionEntries) {
      // Check if subscription is still active
      if (!connection.subscription.isActive()) {
        this.logger.warn(`Sensor ${sensorId} subscription is inactive, reconnecting...`);
        await this.stopSensorDataCollection(sensorId);

        try {
          const freshSensor = await this.reloadSensor(sensorId, connection.sensor.tenantId);
          if (freshSensor) {
            await this.startSensorDataCollection(freshSensor);
          }
        } catch (error) {
          this.logger.error(
            `Health check reconnect failed for ${sensorId}: ${(error as Error).message}`,
          );
        }
        continue;
      }

      // Check for stale connections (no data for too long)
      if (connection.lastReadingAt) {
        const lastReadingAge = now - connection.lastReadingAt.getTime();
        if (lastReadingAge > staleThreshold) {
          this.logger.warn(
            `Sensor ${sensorId} has not received data for ${Math.round(lastReadingAge / 1000)}s`,
          );

          // Update status to indicate potential issue
          await this.updateSensor(connection.sensor, {
            status: SensorStatus.OFFLINE,
          });
        }
      }
    }
  }

  /**
   * Get status of all active connections
   */
  getActiveConnections(): {
    sensorId: string;
    name: string;
    lastReadingAt?: Date;
    errorCount: number;
  }[] {
    return Array.from(this.activeConnections.entries()).map(([sensorId, conn]) => ({
      sensorId,
      name: conn.sensor.name,
      lastReadingAt: conn.lastReadingAt,
      errorCount: conn.errorCount,
    }));
  }

  /**
   * Manually trigger sensor connection start
   */
  async startSensor(sensorId: string, tenantId: string): Promise<void> {
    const sensor = await this.reloadSensor(sensorId, tenantId);

    if (!sensor) {
      throw new Error(`Sensor ${sensorId} not found`);
    }

    await this.startSensorDataCollection(sensor);
  }

  /**
   * Manually stop sensor connection
   */
  async stopSensor(sensorId: string): Promise<void> {
    await this.stopSensorDataCollection(sensorId);
  }
}
