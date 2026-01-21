import { randomUUID } from 'crypto';

import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { IEventBus } from '@platform/event-bus';
import * as mqtt from 'mqtt';
import { MqttClient } from 'mqtt';
import { Repository, DataSource } from 'typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { QualityCodes, SensorMetricInput } from '../database/entities/sensor-metric.entity';
import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor, SensorStatus } from '../database/entities/sensor.entity';
import { EdgeDeviceService, DeviceHeartbeat } from '../edge-device/edge-device.service';


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
 * MQTT Listener Service
 * Global MQTT listener that subscribes to all sensor topics
 * and routes data to appropriate sensors
 */
@Injectable()
export class MqttListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttListenerService.name);
  private client: MqttClient | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @InjectRepository(SensorReading)
    private readonly readingRepository: Repository<SensorReading>,
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
    @Optional()
    @Inject(forwardRef(() => EdgeDeviceService))
    private readonly edgeDeviceService: EdgeDeviceService | null,
  ) {}

  async onModuleInit(): Promise<void> {
    const mqttEnabled = this.configService.get('MQTT_ENABLED', 'true') === 'true';

    if (!mqttEnabled) {
      this.logger.log('MQTT Listener is disabled');
      return;
    }

    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    const brokerUrl = this.configService.get('MQTT_BROKER_URL', 'mqtt://localhost:1883');
    const username = this.configService.get('MQTT_USERNAME');
    const password = this.configService.get('MQTT_PASSWORD');
    const clientId = `aqua-sensor-service-${process.pid}-${Date.now()}`;

    this.logger.log(`Connecting to MQTT broker: ${brokerUrl}`);

    const options: mqtt.IClientOptions = {
      clientId,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
    };

    if (username) {
      options.username = username;
      options.password = password;
    }

    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(brokerUrl, options);

      this.client.on('connect', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.logger.log('Connected to MQTT broker');

        // Subscribe to all sensor topics
        this.subscribeToTopics();
        resolve();
      });

      this.client.on('error', (error) => {
        this.logger.error(`MQTT error: ${error.message}`);
        if (!this.isConnected) {
          reject(error);
        }
      });

      this.client.on('close', () => {
        this.isConnected = false;
        this.logger.warn('MQTT connection closed');
      });

      this.client.on('reconnect', () => {
        this.reconnectAttempts++;
        this.logger.log(`Reconnecting to MQTT broker (attempt ${this.reconnectAttempts})`);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.logger.error('Max reconnect attempts reached, stopping');
          this.client?.end(true);
        }
      });

      this.client.on('message', (topic, message) => {
        this.handleMessage(topic, message);
      });
    });
  }

  /**
   * Disconnect from MQTT broker
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      return new Promise((resolve) => {
        this.client!.end(false, {}, () => {
          this.logger.log('Disconnected from MQTT broker');
          resolve();
        });
      });
    }
  }

  /**
   * Subscribe to sensor and edge device topics
   */
  private subscribeToTopics(): void {
    if (!this.client) return;

    // Subscribe to wildcard topic patterns
    const topics = [
      // Sensor data topics
      'sensors/#',                    // All sensor data
      'aquaculture/+/sensors/#',      // Tenant-specific sensors
      '+/+/+/temperature-array',      // Array sensor pattern

      // Edge device topics - Legacy pattern (backward compatibility)
      'edge/+/heartbeat',             // Device heartbeat (health metrics)
      'edge/+/birth',                 // Device birth certificate
      'edge/+/death',                 // Device death (LWT - Last Will Testament)
      'edge/+/response',              // Command response from device

      // Edge device topics - Tenant-prefixed pattern (Edge Agent v2.0 default)
      // Pattern: tenants/{tenantId}/devices/{deviceCode}/{messageType}
      'tenants/+/devices/+/telemetry',  // Device telemetry (CPU, RAM, Disk, Temp)
      'tenants/+/devices/+/status',     // Device status (online/offline)
      'tenants/+/devices/+/response',   // Command response
    ];

    for (const topic of topics) {
      this.client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          this.logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
        } else {
          this.logger.log(`Subscribed to topic: ${topic}`);
        }
      });
    }
  }

  /**
   * Handle incoming MQTT message
   */
  private async handleMessage(topic: string, message: Buffer): Promise<void> {
    try {
      const payload = message.toString();
      this.logger.debug(`Received message on ${topic}: ${payload.substring(0, 100)}`);

      // Route edge device messages - Legacy pattern (edge/{deviceCode}/{type})
      if (topic.startsWith('edge/')) {
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

      // Set tenant schema for database operations
      await this.setTenantSchema(sensor.tenantId);

      // Parse message payload
      const data = this.parsePayload(payload, sensor);

      if (!data) {
        this.logger.warn(`Failed to parse payload for topic ${topic}`);
        return;
      }

      // Save reading
      await this.saveReading(sensor, data);

      // Update sensor last seen and connection status
      const now = new Date();
      await this.sensorRepository.update(sensor.id, {
        lastSeenAt: now,
        status: SensorStatus.ACTIVE,
        connectionStatus: {
          isConnected: true,
          lastTestedAt: now,
        },
      });

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
      const payload = JSON.parse(message.toString());

      switch (messageType) {
        case 'heartbeat':
          await this.handleEdgeHeartbeat(deviceCode, payload);
          break;
        case 'birth':
          await this.handleEdgeBirth(deviceCode, payload);
          break;
        case 'death':
          await this.handleEdgeDeath(deviceCode, payload);
          break;
        case 'response':
          await this.handleEdgeResponse(deviceCode, payload);
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
  private async handleEdgeHeartbeat(deviceCode: string, payload: Record<string, any>): Promise<void> {
    this.logger.debug(`Edge heartbeat from ${deviceCode}: CPU=${payload.cpuUsage}%, Mem=${payload.memoryUsage}%`);

    const heartbeat: DeviceHeartbeat = {
      deviceCode,
      isOnline: payload.isOnline ?? true,
      cpuUsage: payload.cpuUsage,
      memoryUsage: payload.memoryUsage,
      storageUsage: payload.storageUsage,
      temperatureCelsius: payload.temperatureCelsius,
      uptimeSeconds: payload.uptimeSeconds,
      firmwareVersion: payload.firmwareVersion,
      ipAddress: payload.ipAddress,
    };

    const device = await this.edgeDeviceService!.updateHeartbeat(heartbeat);

    if (device) {
      this.logger.debug(`Updated heartbeat for device ${deviceCode} (${device.id})`);

      // Publish real-time event for WebSocket clients
      if (this.eventBus) {
        await this.eventBus.publish({
          eventId: randomUUID(),
          eventType: 'EdgeDeviceHeartbeat',
          timestamp: new Date(),
          payload: {
            deviceId: device.id,
            deviceCode: device.deviceCode,
            tenantId: device.tenantId,
            isOnline: device.isOnline,
            cpuUsage: device.cpuUsage,
            memoryUsage: device.memoryUsage,
            storageUsage: device.storageUsage,
            temperatureCelsius: device.temperatureCelsius,
          },
          metadata: {
            tenantId: device.tenantId,
            source: 'mqtt-listener',
          },
        });
      }
    }
  }

  /**
   * Handle edge device birth message (device came online)
   */
  private async handleEdgeBirth(deviceCode: string, payload: Record<string, any>): Promise<void> {
    this.logger.log(`Edge device birth: ${deviceCode}`);

    // Update device as online with birth certificate data
    const heartbeat: DeviceHeartbeat = {
      deviceCode,
      isOnline: true,
      firmwareVersion: payload.firmwareVersion || payload.properties?.firmwareVersion,
      ipAddress: payload.ipAddress || payload.properties?.ipAddress,
    };

    await this.edgeDeviceService!.updateHeartbeat(heartbeat);
  }

  /**
   * Handle edge device death message (device went offline - LWT)
   */
  private async handleEdgeDeath(deviceCode: string, payload: Record<string, any>): Promise<void> {
    this.logger.warn(`Edge device death: ${deviceCode}`);

    // Mark device as offline
    const heartbeat: DeviceHeartbeat = {
      deviceCode,
      isOnline: false,
    };

    await this.edgeDeviceService!.updateHeartbeat(heartbeat);
  }

  /**
   * Handle edge device command response
   */
  private async handleEdgeResponse(deviceCode: string, payload: Record<string, any>): Promise<void> {
    this.logger.debug(`Edge response from ${deviceCode}: ${JSON.stringify(payload)}`);

    // Route ping responses to EdgeDeviceService for promise resolution
    if (payload.command === 'ping' && this.edgeDeviceService) {
      this.edgeDeviceService.handlePingResponse(deviceCode, payload);
    }

    // Publish response event for command tracking
    if (this.eventBus) {
      await this.eventBus.publish({
        eventId: randomUUID(),
        eventType: 'EdgeDeviceResponse',
        timestamp: new Date(),
        payload: {
          deviceCode,
          commandId: payload.commandId,
          success: payload.success,
          command: payload.command,
          data: payload.data,
          error: payload.error,
        },
        metadata: {
          source: 'mqtt-listener',
        },
      });
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
      const payload = JSON.parse(message.toString());

      switch (messageType) {
        case 'telemetry':
          await this.handleTenantEdgeTelemetry(tenantId, deviceCode, payload);
          break;

        case 'status':
          await this.handleTenantEdgeStatus(tenantId, deviceCode, payload);
          break;

        case 'response':
          await this.handleEdgeResponse(deviceCode, payload);
          break;

        default:
          this.logger.debug(`Unknown tenant edge message type: ${messageType}`);
      }
    } catch (error) {
      this.logger.error(`Failed to parse tenant-prefixed message on ${topic}: ${(error as Error).message}`);
    }
  }

  /**
   * Handle telemetry from Edge Agent (tenant-prefixed topic)
   * Converts Edge Agent TelemetryMetrics format to DeviceHeartbeat
   */
  private async handleTenantEdgeTelemetry(
    tenantId: string,
    deviceCode: string,
    payload: Record<string, any>,
  ): Promise<void> {
    // Edge Agent TelemetryMetrics uses snake_case field names
    const heartbeat: DeviceHeartbeat = {
      deviceCode,
      isOnline: true,
      cpuUsage: payload.cpu_usage_percent ?? payload.cpuUsage,
      memoryUsage: payload.memory_usage_percent ?? payload.memoryUsage,
      storageUsage: payload.disk_usage_percent ?? payload.storageUsage,
      temperatureCelsius: payload.temperature_celsius ?? payload.temperatureCelsius,
      uptimeSeconds: payload.uptime_secs ?? payload.uptimeSeconds,
      // Additional fields from Edge Agent
      firmwareVersion: payload.agent_version ?? payload.firmwareVersion,
    };

    const device = await this.edgeDeviceService!.updateHeartbeat(heartbeat);

    if (device) {
      this.logger.debug(
        `Tenant ${tenantId} edge telemetry from ${deviceCode}: ` +
        `CPU=${heartbeat.cpuUsage?.toFixed(1)}%, ` +
        `RAM=${heartbeat.memoryUsage?.toFixed(1)}%, ` +
        `Disk=${heartbeat.storageUsage?.toFixed(1)}%`
      );

      // Publish real-time event for WebSocket clients
      if (this.eventBus) {
        await this.eventBus.publish({
          eventId: randomUUID(),
          eventType: 'EdgeDeviceHeartbeat',
          timestamp: new Date(),
          payload: {
            deviceId: device.id,
            deviceCode: device.deviceCode,
            tenantId: device.tenantId,
            isOnline: device.isOnline,
            cpuUsage: device.cpuUsage,
            memoryUsage: device.memoryUsage,
            storageUsage: device.storageUsage,
            temperatureCelsius: device.temperatureCelsius,
            uptimeSeconds: device.uptimeSeconds,
          },
          metadata: {
            tenantId: device.tenantId,
            source: 'mqtt-listener',
            topicPattern: 'tenant-prefixed',
          },
        });
      }
    } else {
      this.logger.warn(`No device found for telemetry: tenantId=${tenantId}, deviceCode=${deviceCode}`);
    }
  }

  /**
   * Handle status message from Edge Agent (tenant-prefixed topic)
   * Status can be: online, offline, error
   */
  private async handleTenantEdgeStatus(
    tenantId: string,
    deviceCode: string,
    payload: Record<string, any>,
  ): Promise<void> {
    const status = (payload.status || '').toLowerCase();

    if (status === 'online') {
      this.logger.log(`Tenant ${tenantId} edge device online: ${deviceCode}`);
      await this.handleEdgeBirth(deviceCode, payload);
    } else if (status === 'offline') {
      this.logger.warn(`Tenant ${tenantId} edge device offline: ${deviceCode}`);
      await this.handleEdgeDeath(deviceCode, payload);
    } else if (status === 'error') {
      this.logger.error(`Tenant ${tenantId} edge device error: ${deviceCode} - ${payload.message || 'Unknown error'}`);
      // Mark as offline with error
      const heartbeat: DeviceHeartbeat = {
        deviceCode,
        isOnline: false,
      };
      await this.edgeDeviceService!.updateHeartbeat(heartbeat);
    } else {
      this.logger.debug(`Unknown edge status: ${status} for device ${deviceCode}`);
    }
  }

  // ==================== Sensor Reading Events ====================

  /**
   * Publish sensor reading event for real-time updates
   */
  private async publishSensorReadingEvent(
    sensor: Sensor,
    data: Record<string, any>,
    timestamp: Date,
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    try {
      await this.eventBus.publish({
        eventId: randomUUID(),
        eventType: 'SensorReadingReceived',
        timestamp,
        payload: {
          sensorId: sensor.id,
          sensorName: sensor.name,
          tenantId: sensor.tenantId,
          readings: data,
          timestamp: timestamp.toISOString(),
        },
        metadata: {
          tenantId: sensor.tenantId,
          source: 'mqtt-listener',
        },
      });
      this.logger.debug(`Published SensorReadingReceived event for sensor ${sensor.id}`);
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
    if (parts[0] === 'aquaculture' && parts[2] === 'sensors' && parts.length >= 4 && parts[1] && parts[3]) {
      return {
        tenantId: parts[1],
        sensorId: parts[3],
      };
    }

    // Pattern: {farm}/{pool}/{sensor-type}
    if (parts.length >= 3) {
      return {
        tenantId: 'unknown',
        location: topic,
      };
    }

    return null;
  }

  /**
   * Find sensor by topic pattern - searches across ALL tenant schemas
   * This is necessary because MQTT messages come in globally and we need
   * to find which tenant's sensor matches the topic
   */
  private async findSensorByTopic(topic: string, parsed: ParsedTopic | null): Promise<Sensor | null> {
    try {
      // Get all tenant schemas
      const tenantSchemas = await this.dataSource.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
      `);

      // Search in each tenant schema
      for (const { schema_name } of tenantSchemas) {
        try {
          // Set search_path to this tenant's schema
          // Sanitize schema name to prevent SQL injection
          const safeSchemaName = schema_name.replace(/[^a-zA-Z0-9_]/g, '');
          await this.dataSource.query(`SET search_path TO "${safeSchemaName}", public`);

          // Check if sensors table exists in this schema
          const tableCheck = await this.dataSource.query(`
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = 'sensors'
          `, [schema_name]);

          if (tableCheck.length === 0) {
            continue; // Skip schemas without sensors table
          }

          // Try exact topic match
          const sensorByTopic = await this.sensorRepository
            .createQueryBuilder('sensor')
            .where(`sensor."protocol_configuration"->>'topic' = :topic`, { topic })
            .getOne();

          if (sensorByTopic) {
            this.logger.debug(`Found sensor ${sensorByTopic.id} in schema ${schema_name} for topic ${topic}`);
            return sensorByTopic;
          }

          // Try wildcard match
          const sensorsWithWildcard = await this.sensorRepository
            .createQueryBuilder('sensor')
            .where(`sensor."protocol_configuration"->>'topic' LIKE '%#%'`)
            .orWhere(`sensor."protocol_configuration"->>'topic' LIKE '%+%'`)
            .getMany();

          for (const sensor of sensorsWithWildcard) {
            const configTopic = sensor.protocolConfiguration?.topic as string;
            if (configTopic && this.topicMatches(configTopic, topic)) {
              this.logger.debug(`Found sensor ${sensor.id} in schema ${schema_name} via wildcard for topic ${topic}`);
              return sensor;
            }
          }

          // Try by sensor ID from topic
          if (parsed?.sensorId) {
            const sensorById = await this.sensorRepository.findOne({
              where: { id: parsed.sensorId },
            });
            if (sensorById) {
              return sensorById;
            }

            // Try by serial number
            const sensorBySerial = await this.sensorRepository.findOne({
              where: { serialNumber: parsed.sensorId },
            });
            if (sensorBySerial) {
              return sensorBySerial;
            }
          }
        } catch (schemaError) {
          // Skip this schema if there's an error
          this.logger.debug(`Error searching in schema ${schema_name}: ${(schemaError as Error).message}`);
          continue;
        }
      }

      // Reset to public schema if no sensor found
      await this.dataSource.query(`SET search_path TO public`);
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
  private parsePayload(payload: string, sensor: Sensor): Record<string, any> | null {
    const format = sensor.protocolConfiguration?.payloadFormat || 'json';

    switch (format) {
      case 'json':
        try {
          return JSON.parse(payload);
        } catch {
          this.logger.warn(`Failed to parse JSON payload: ${payload.substring(0, 50)}`);
          return null;
        }

      case 'csv':
        const parts = payload.split(',');
        const result: Record<string, number> = {};
        parts.forEach((part, index) => {
          const num = parseFloat(part.trim());
          if (!isNaN(num)) {
            result[`value_${index}`] = num;
          }
        });
        return result;

      case 'text':
        const num = parseFloat(payload.trim());
        if (!isNaN(num)) {
          return { value: num };
        }
        return { raw: payload };

      default:
        try {
          return JSON.parse(payload);
        } catch {
          return { raw: payload };
        }
    }
  }

  /**
   * Save sensor reading to database using narrow table format
   * Each channel value becomes a separate row in sensor_metrics
   */
  private async saveReading(sensor: Sensor, data: Record<string, any>): Promise<void> {
    const now = new Date();

    // Get all channels for this sensor
    const channels = await this.channelRepository.find({
      where: { sensorId: sensor.id, isEnabled: true },
    });

    // Collect metrics for batch insert
    const metrics: SensorMetricInput[] = [];

    for (const channel of channels) {
      // Extract value using dataPath or channelKey
      const rawValue = channel.dataPath
        ? this.extractValue(data, channel.dataPath)
        : data[channel.channelKey];

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

    // Batch INSERT all metrics
    if (metrics.length > 0) {
      await this.batchInsertMetrics(metrics);
    }

    // Also write to legacy table for backward compatibility
    await this.writeLegacyReading(sensor, data);

    this.logger.debug(`Saved ${metrics.length} metrics for sensor ${sensor.id}`);
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
      'mqtt',
      '${m.time.toISOString()}',
      0,
      NULL
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
   * TODO: Remove after migration is complete
   */
  private async writeLegacyReading(sensor: Sensor, data: Record<string, any>): Promise<void> {
    const reading = this.readingRepository.create({
      id: randomUUID(),
      sensorId: sensor.id,
      tenantId: sensor.tenantId,
      timestamp: new Date(),
      readings: data,
      pondId: sensor.pondId,
      farmId: sensor.farmId,
      quality: 100,
      source: 'mqtt',
    });

    await this.readingRepository.save(reading);
  }

  /**
   * Extract value from object by path
   */
  private extractValue(obj: Record<string, any>, path: string): any {
    const parts = path.split('.');
    let current: any = obj;

    for (const part of parts) {
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const key = arrayMatch[1];
        const indexStr = arrayMatch[2];
        if (key && indexStr) {
          current = current?.[key]?.[parseInt(indexStr, 10)];
        }
      } else {
        current = current?.[part];
      }

      if (current === undefined) {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Set PostgreSQL search_path for tenant-specific schema
   * This ensures all database operations target the correct tenant's tables
   */
  private async setTenantSchema(tenantId: string): Promise<void> {
    if (!tenantId || tenantId === 'default-tenant') {
      // Fallback to shared sensor schema
      await this.dataSource.query(`SET search_path TO "sensor", public`);
      return;
    }

    // Sanitize tenant ID to prevent SQL injection - only allow alphanumeric and underscore
    const cleanId = tenantId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8);
    const schemaName = `tenant_${cleanId}`;

    // Additional validation: ensure schema name is safe
    if (!/^tenant_[a-zA-Z0-9]+$/.test(schemaName)) {
      this.logger.warn(`Invalid schema name generated: ${schemaName}, falling back to sensor`);
      await this.dataSource.query(`SET search_path TO "sensor", public`);
      return;
    }

    try {
      await this.dataSource.query(`SET search_path TO "${schemaName}", public`);
      this.logger.debug(`Schema set to: ${schemaName}`);
    } catch (error) {
      // If tenant schema doesn't exist, fallback to sensor schema
      this.logger.warn(`Failed to set schema ${schemaName}, falling back to sensor: ${error}`);
      await this.dataSource.query(`SET search_path TO "sensor", public`);
    }
  }

  /**
   * Get connection status
   */
  isConnectedToBroker(): boolean {
    return this.isConnected;
  }

  /**
   * Publish message to topic (for testing)
   */
  async publish(topic: string, message: string | object): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('Not connected to MQTT broker');
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);

    return new Promise((resolve, reject) => {
      this.client!.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
