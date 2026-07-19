import { randomUUID } from 'crypto';

import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { IEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import { Repository, DataSource } from 'typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { QualityCodes, SensorMetricInput } from '../database/entities/sensor-metric.entity';
import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor, SensorStatus, SensorRegistrationStatus } from '../database/entities/sensor.entity';
import { SensorServiceProfileService } from '../config/sensor-service-profile.service';
import { ConnectionHandle, DataSubscription, SensorReadingData } from '../protocol/adapters/base-protocol.adapter';
import { MqttAdapter, MqttConfiguration } from '../protocol/adapters/iot/mqtt.adapter';

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
 */
@Injectable()
export class DataIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataIngestionService.name);
  private readonly activeConnections = new Map<string, ActiveConnection>();
  private readonly mqttAdapter: MqttAdapter;
  private isShuttingDown = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  // Channel lookup cache: sensorId -> { channels, expiresAt }
  private readonly channelCache = new Map<string, { channels: SensorDataChannel[]; expiresAt: number }>();
  private readonly CHANNEL_CACHE_TTL_MS = 60_000; // 60 seconds

  // lastSeenAt debounce: sensorId -> pending timestamp
  private readonly lastSeenPending = new Map<string, Date>();
  private lastSeenFlushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly LAST_SEEN_FLUSH_INTERVAL_MS = 30_000; // 30 seconds

  constructor(
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @InjectRepository(SensorReading)
    private readonly readingRepository: Repository<SensorReading>,
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
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
        this.logger.error(`Failed to flush lastSeenAt updates: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.LAST_SEEN_FLUSH_INTERVAL_MS);

    this.logger.log(`Data Ingestion Service initialized with ${this.activeConnections.size} active connections`);
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
      // Find all active sensors with MQTT protocol
      const activeSensors = await this.sensorRepository
        .createQueryBuilder('sensor')
        .leftJoinAndSelect('sensor.protocol', 'protocol')
        .where('sensor.registrationStatus = :status', { status: SensorRegistrationStatus.ACTIVE })
        .andWhere('sensor.isActive = :isActive', { isActive: true })
        .andWhere('sensor.isParentDevice = :isParent', { isParent: true })
        .andWhere('protocol.code = :code', { code: 'MQTT' })
        .getMany();

      this.logger.log(`Found ${activeSensors.length} active MQTT parent sensors`);

      for (const sensor of activeSensors) {
        try {
          await this.startSensorDataCollection(sensor);
        } catch (error) {
          this.logger.error(
            `Failed to start data collection for sensor ${sensor.id}: ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Failed to start active sensors: ${(error as Error).message}`);
    }
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
        (data) => { void this.handleSensorData(sensor, data); },
        (error) => { void this.handleSensorError(sensor, error); },
      );

      // Store active connection
      this.activeConnections.set(sensor.id, {
        sensor,
        handle,
        subscription,
        errorCount: 0,
      });

      // Update sensor status
      await this.sensorRepository.update(sensor.id, {
        status: SensorStatus.ACTIVE,
        lastSeenAt: new Date(),
      });

      this.logger.log(`Successfully connected to sensor ${sensor.id}`);
    } catch (error) {
      this.logger.error(
        `Failed to connect to sensor ${sensor.id}: ${(error as Error).message}`,
      );

      // Update sensor status to error
      await this.sensorRepository.update(sensor.id, {
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
      this.logger.error(
        `Error stopping sensor ${sensorId}: ${(error as Error).message}`,
      );
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
      const channels = await this.getChannelsCached(sensor.id);

      // Collect metrics for batch insert
      const metrics: SensorMetricInput[] = [];

      for (const channel of channels) {
        // Extract value using dataPath
        const rawValue = channel.dataPath
          ? this.extractValueByPath(data.values, channel.dataPath)
          : data.values[channel.channelKey];

        if (rawValue === undefined || rawValue === null) {
          continue;
        }

        // Convert to number
        const numericRawValue = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue));
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
      }

      // Batch INSERT all metrics using raw SQL for maximum performance
      if (metrics.length > 0) {
        await this.batchInsertMetrics(metrics);
      }

      // Write to legacy table for backward compatibility (deprecated, will be removed)
      // Default: disabled. Only enable if explicitly needed for migration.
      const legacyEnabled = this.configService.get('LEGACY_SENSOR_READINGS_ENABLED', 'false') === 'true';
      if (legacyEnabled) {
        if (this.configService.get('NODE_ENV') === 'production') {
          this.logger.warn('LEGACY_SENSOR_READINGS_ENABLED=true in production — dual write doubles I/O. Migrate to sensor_metrics and disable.');
        }
        await this.writeLegacyReading(sensor, data);
      }

      // Publish SensorReading NATS event so alert-engine can evaluate this data path
      if (this.eventBus && metrics.length > 0) {
        try {
          await this.eventBus.publish({
            ...createBaseEvent('SensorReading', sensor.tenantId, { aggregateId: sensor.id, aggregateType: 'Sensor' }),
            timestamp: sourceTimestamp.toISOString(),
            sensorId: sensor.id,
            readings: data.values,
          });
        } catch (error) {
          this.logger.warn(`Failed to publish SensorReading event: ${(error as Error).message}`);
        }
      }

      // Debounce lastSeenAt update — flushed in batch every 30 seconds
      this.lastSeenPending.set(sensor.id, now);

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
  private async getChannelsCached(sensorId: string): Promise<SensorDataChannel[]> {
    const cached = this.channelCache.get(sensorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.channels;
    }

    const channels = await this.channelRepository.find({
      where: { sensorId, isEnabled: true },
    });

    this.channelCache.set(sensorId, {
      channels,
      expiresAt: Date.now() + this.CHANNEL_CACHE_TTL_MS,
    });

    return channels;
  }

  /**
   * Flush all pending lastSeenAt updates in a single batch query
   */
  private async flushLastSeenUpdates(): Promise<void> {
    if (this.lastSeenPending.size === 0) return;

    const ids = Array.from(this.lastSeenPending.keys());
    this.lastSeenPending.clear();

    try {
      await this.sensorRepository
        .createQueryBuilder()
        .update()
        .set({ lastSeenAt: () => 'NOW()', status: SensorStatus.ACTIVE })
        .where('id IN (:...ids)', { ids })
        .execute();

      this.logger.debug(`Flushed lastSeenAt for ${ids.length} sensors`);
    } catch (error) {
      this.logger.error(`Failed to flush lastSeenAt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Validate UUID format to prevent SQL injection
   */
  private isValidUUID(str: string | null | undefined): boolean {
    if (!str) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  /**
   * Batch insert metrics using parameterized queries for maximum security
   *
   * SECURITY FIX: Changed from string interpolation to parameterized queries
   * to prevent SQL injection attacks.
   *
   * Uses chunked inserts to handle large batches efficiently while
   * staying within PostgreSQL parameter limits (65535 params max).
   */
  private async batchInsertMetrics(metrics: SensorMetricInput[]): Promise<void> {
    if (metrics.length === 0) return;

    // Validate required UUIDs and filter invalid entries
    const validMetrics = metrics.filter(m => {
      if (!this.isValidUUID(m.sensorId) || !this.isValidUUID(m.channelId) || !this.isValidUUID(m.tenantId)) {
        this.logger.warn(`Skipping metric with invalid UUID - sensorId: ${m.sensorId}, channelId: ${m.channelId}`);
        return false;
      }
      // SECURITY: Validate Infinity values that could cause issues
      if (!Number.isFinite(m.rawValue) || !Number.isFinite(m.value)) {
        this.logger.warn(`Skipping metric with non-finite value - rawValue: ${m.rawValue}, value: ${m.value}`);
        return false;
      }
      return true;
    });

    if (validMetrics.length === 0) return;

    // SECURITY: Use parameterized queries instead of string interpolation
    // Parameters per row: 19
    // PostgreSQL max parameters: 65535
    // Safe batch size: floor(65535 / 19) = 3449, using 1000 for safety
    const BATCH_SIZE = 1000;
    const chunks: SensorMetricInput[][] = [];

    for (let i = 0; i < validMetrics.length; i += BATCH_SIZE) {
      chunks.push(validMetrics.slice(i, i + BATCH_SIZE));
    }

    for (const chunk of chunks) {
      await this.insertMetricChunk(chunk);
    }
  }

  /**
   * Insert a single chunk of metrics using parameterized queries
   */
  private async insertMetricChunk(metrics: SensorMetricInput[]): Promise<void> {
    const params: unknown[] = [];
    const valuePlaceholders: string[] = [];

    let paramIndex = 1;
    const PARAMS_PER_ROW = 19;

    for (const m of metrics) {
      const placeholders: string[] = [];

      // Build placeholders for this row
      for (let i = 0; i < PARAMS_PER_ROW; i++) {
        placeholders.push(`$${paramIndex++}`);
      }

      valuePlaceholders.push(`(${placeholders.join(', ')})`);

      // Push parameters in order
      params.push(
        m.time.toISOString(),                                    // time
        m.sensorId,                                              // "sensorId"
        m.channelId,                                             // "channelId"
        m.tenantId,                                              // "tenantId"
        m.siteId || null,                                        // "siteId"
        m.departmentId || null,                                  // "departmentId"
        m.systemId || null,                                      // "systemId"
        m.equipmentId || null,                                   // "equipmentId"
        m.tankId || null,                                        // "tankId"
        m.pondId || null,                                        // "pondId"
        m.farmId || null,                                        // "farmId"
        Number.isFinite(m.rawValue) ? m.rawValue : 0,           // "rawValue"
        Number.isFinite(m.value) ? m.value : 0,                 // value
        Number.isInteger(m.qualityCode) ? m.qualityCode : 192,  // "qualityCode"
        Number.isInteger(m.qualityBits) ? m.qualityBits : 0,    // "qualityBits"
        m.sourceProtocol ? m.sourceProtocol.replace(/[^a-zA-Z0-9_-]/g, '') : null, // "sourceProtocol"
        m.sourceTimestamp?.toISOString() || null,               // "sourceTimestamp"
        m.sourceTimestamp ? new Date().getTime() - m.sourceTimestamp.getTime() : null, // "ingestionLatencyMs"
        m.batchId || null,                                      // "batchId"
      );
    }

    const sql = `
      INSERT INTO sensor.sensor_metrics (
        time, sensor_id, channel_id, tenant_id,
        site_id, department_id, system_id, equipment_id, tank_id, pond_id, farm_id,
        raw_value, value, quality_code, quality_bits,
        source_protocol, source_timestamp, ingestion_latency_ms, batch_id
      ) VALUES ${valuePlaceholders.join(',\n')}
      ON CONFLICT (time, sensor_id, channel_id) DO UPDATE SET
        value = EXCLUDED.value,
        raw_value = EXCLUDED.raw_value,
        quality_code = EXCLUDED.quality_code
    `;

    await this.dataSource.query(sql, params);
  }

  /**
   * Write to legacy sensor_readings table for backward compatibility
   * @deprecated Use sensor_metrics table instead. Controlled by LEGACY_SENSOR_READINGS_ENABLED env var.
   * This method will be removed once all consumers migrate to sensor_metrics.
   */
  private async writeLegacyReading(sensor: Sensor, data: SensorReadingData): Promise<void> {
    const reading = this.readingRepository.create({
      id: randomUUID(),
      sensorId: sensor.id,
      tenantId: sensor.tenantId,
      timestamp: data.timestamp,
      readings: data.values,
      pondId: sensor.pondId,
      farmId: sensor.farmId,
      quality: data.quality,
      source: data.source || 'mqtt',
    });

    await this.readingRepository.save(reading);
  }

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
                const freshSensor = await this.sensorRepository.findOne({
                  where: { id: sensor.id },
                  relations: ['protocol'],
                });
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
          const freshSensor = await this.sensorRepository.findOne({
            where: { id: sensorId },
            relations: ['protocol'],
          });
          if (freshSensor) {
            await this.startSensorDataCollection(freshSensor);
          }
        } catch (error) {
          this.logger.error(`Health check reconnect failed for ${sensorId}: ${(error as Error).message}`);
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
          await this.sensorRepository.update(sensorId, {
            status: SensorStatus.OFFLINE,
          });
        }
      }
    }
  }

  /**
   * Get status of all active connections
   */
  getActiveConnections(): { sensorId: string; name: string; lastReadingAt?: Date; errorCount: number }[] {
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
  async startSensor(sensorId: string): Promise<void> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId },
      relations: ['protocol'],
    });

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
