import { randomUUID } from 'crypto';

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { QualityCodes, SensorMetricInput } from '../database/entities/sensor-metric.entity';
import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor, SensorStatus, SensorRegistrationStatus } from '../database/entities/sensor.entity';
import { ConnectionHandle, DataSubscription, SensorReadingData } from '../protocol/adapters/base-protocol.adapter';
import { MqttAdapter } from '../protocol/adapters/iot/mqtt.adapter';

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
  ) {
    this.mqttAdapter = new MqttAdapter(configService);
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing Data Ingestion Service...');

    // Start connecting to active sensors
    await this.startAllActiveSensors();

    // Start health check interval
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck().catch((error: Error) => {
        this.logger.error(`Health check failed: ${error.message}`, error.stack);
      });
    }, 30000); // Every 30 seconds

    this.logger.log(`Data Ingestion Service initialized with ${this.activeConnections.size} active connections`);
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down Data Ingestion Service...');
    this.isShuttingDown = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

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
      const handle = await this.mqttAdapter.connect(config);

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

      // Get all channels for this sensor
      const channels = await this.channelRepository.find({
        where: { sensorId: sensor.id, isEnabled: true },
      });

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
      // Set LEGACY_SENSOR_READINGS_ENABLED=false when migration to sensor_metrics is complete
      const legacyEnabled = this.configService.get('LEGACY_SENSOR_READINGS_ENABLED', 'true') === 'true';
      if (legacyEnabled) {
        await this.writeLegacyReading(sensor, data);
      }

      // Update last seen timestamp
      await this.sensorRepository.update(sensor.id, {
        lastSeenAt: now,
      });

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
   * Validate UUID format to prevent SQL injection
   */
  private isValidUUID(str: string | null | undefined): boolean {
    if (!str) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  /**
   * Safely format UUID for SQL or return NULL
   */
  private formatUUID(uuid: string | null | undefined): string {
    if (!uuid) return 'NULL';
    if (!this.isValidUUID(uuid)) {
      this.logger.warn(`Invalid UUID detected: ${uuid?.substring(0, 20)}`);
      return 'NULL';
    }
    return `'${uuid}'`;
  }

  /**
   * Safely format protocol string - only allow alphanumeric and underscore
   */
  private formatProtocol(protocol: string | null | undefined): string {
    if (!protocol) return 'NULL';
    const safeProtocol = protocol.replace(/[^a-zA-Z0-9_-]/g, '');
    if (safeProtocol.length === 0) return 'NULL';
    return `'${safeProtocol}'`;
  }

  /**
   * Batch insert metrics using raw SQL for maximum throughput
   * Note: UUID values are validated before insertion to prevent SQL injection
   */
  private async batchInsertMetrics(metrics: SensorMetricInput[]): Promise<void> {
    if (metrics.length === 0) return;

    // Validate required UUIDs
    const validMetrics = metrics.filter(m => {
      if (!this.isValidUUID(m.sensorId) || !this.isValidUUID(m.channelId) || !this.isValidUUID(m.tenantId)) {
        this.logger.warn(`Skipping metric with invalid UUID - sensorId: ${m.sensorId}, channelId: ${m.channelId}`);
        return false;
      }
      return true;
    });

    if (validMetrics.length === 0) return;

    const values = validMetrics.map(m => `(
      '${m.time.toISOString()}',
      ${this.formatUUID(m.sensorId)},
      ${this.formatUUID(m.channelId)},
      ${this.formatUUID(m.tenantId)},
      ${this.formatUUID(m.siteId)},
      ${this.formatUUID(m.departmentId)},
      ${this.formatUUID(m.systemId)},
      ${this.formatUUID(m.equipmentId)},
      ${this.formatUUID(m.tankId)},
      ${this.formatUUID(m.pondId)},
      ${this.formatUUID(m.farmId)},
      ${Number.isFinite(m.rawValue) ? m.rawValue : 0},
      ${Number.isFinite(m.value) ? m.value : 0},
      ${Number.isInteger(m.qualityCode) ? m.qualityCode : 192},
      ${Number.isInteger(m.qualityBits) ? m.qualityBits : 0},
      ${this.formatProtocol(m.sourceProtocol)},
      ${m.sourceTimestamp ? `'${m.sourceTimestamp.toISOString()}'` : 'NULL'},
      ${m.sourceTimestamp ? new Date().getTime() - m.sourceTimestamp.getTime() : 'NULL'},
      ${this.formatUUID(m.batchId)}
    )`).join(',\n');

    await this.dataSource.query(`
      INSERT INTO sensor_metrics (
        time, sensor_id, channel_id, tenant_id,
        site_id, department_id, system_id, equipment_id, tank_id, pond_id, farm_id,
        raw_value, value, quality_code, quality_bits,
        source_protocol, source_timestamp, ingestion_latency_ms, batch_id
      ) VALUES ${values}
      ON CONFLICT (time, sensor_id, channel_id) DO UPDATE SET
        value = EXCLUDED.value,
        raw_value = EXCLUDED.raw_value,
        quality_code = EXCLUDED.quality_code
    `);
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
