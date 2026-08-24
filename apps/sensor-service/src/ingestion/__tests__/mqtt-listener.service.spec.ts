/**
 * MqttListenerService Unit Tests
 *
 * Covers the 85KB MQTT message ingestion entry point:
 * - Topic parsing (sensors/, aquaculture/, tenants/ patterns)
 * - Payload validation (JSON, size limits, empty)
 * - Legacy topic deprecation (LEGACY_EDGE_TOPICS_ENABLED flag)
 * - Sensor lookup (cache hit, cache miss, negative cache)
 * - Tenant isolation (tenantId mismatch)
 * - Message routing (edge/, tenants/, sensor data)
 * - Edge device handlers (telemetry, status, response, io_data, alarms, capabilities, lora_events)
 */

import { ConfigService } from '@nestjs/config';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { getRequestContext } from '@aquaculture/backend-common/logging';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { Sensor, SensorStatus } from '../../database/entities/sensor.entity';
import { DeviceEvent } from '../../edge-device/entities/device-event.entity';
import { DeviceIoConfig } from '../../edge-device/entities/device-io-config.entity';
import { EdgeDeviceService } from '../../edge-device/edge-device.service';
import { MqttClientService } from '../../shared-mqtt/mqtt-client.service';
import { SensorTopicCacheService, CachedSensorInfo } from '../sensor-topic-cache.service';
import { MqttListenerService } from '../mqtt-listener.service';

// ─── Constants ────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SENSOR_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHANNEL_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DEVICE_CODE = 'edge-device-01';

// ─── Helpers ──────────────────────────────────────────────────────────────

function createMockConfigService(overrides: Record<string, string> = {}): ConfigService {
  const config: Record<string, string> = {
    MQTT_ENABLED: 'true',
    LEGACY_EDGE_TOPICS_ENABLED: 'true',
    LEGACY_SENSOR_READINGS_ENABLED: 'false',
    NODE_ENV: 'test',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, defaultValue?: string) => config[key] ?? defaultValue ?? ''),
  } as unknown as ConfigService;
}

function createMockSensorRepository(): jest.Mocked<Repository<Sensor>> {
  return {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    }),
  } as unknown as jest.Mocked<Repository<Sensor>>;
}

function createMockDataSource(): jest.Mocked<DataSource> {
  let isTransactionActive = false;
  const managerRepository = {
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue([]),
    }),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockImplementation(() => {
      isTransactionActive = true;
      return Promise.resolve();
    }),
    commitTransaction: jest.fn().mockImplementation(() => {
      isTransactionActive = false;
      return Promise.resolve();
    }),
    rollbackTransaction: jest.fn().mockImplementation(() => {
      isTransactionActive = false;
      return Promise.resolve();
    }),
    get isTransactionActive(): boolean {
      return isTransactionActive;
    },
    query: jest.fn().mockResolvedValue([]),
    manager: {
      findOne: jest.fn().mockResolvedValue(null),
      getRepository: jest.fn().mockReturnValue(managerRepository),
      create: jest.fn().mockImplementation((_entity, data) => data),
      save: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
    },
    release: jest.fn().mockResolvedValue(undefined),
  };
  return {
    query: jest.fn().mockResolvedValue([]),
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    getRepository: jest.fn().mockReturnValue({
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    }),
  } as unknown as jest.Mocked<DataSource>;
}

function createMockMqttClient(): jest.Mocked<MqttClientService> {
  return {
    addMessageHandler: jest.fn(),
    removeMessageHandler: jest.fn(),
    isConnectedToBroker: jest.fn().mockReturnValue(true),
    subscribe: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(undefined),
    onceConnected: jest.fn(),
  } as unknown as jest.Mocked<MqttClientService>;
}

function createMockEdgeDeviceService(): jest.Mocked<EdgeDeviceService> {
  return {
    updateHeartbeat: jest.fn().mockResolvedValue({
      id: 'dev-1',
      tenantId: TENANT_ID,
      deviceCode: DEVICE_CODE,
      isOnline: true,
    }),
    findByCode: jest
      .fn()
      .mockResolvedValue({ id: 'dev-1', tenantId: TENANT_ID, deviceCode: DEVICE_CODE }),
    // SEC-M01 added findByCodeOnly to handleEdgeDeviceMessage as a
    // legacy-tenant-enforcement gate (mqtt-listener.service.ts:453).
    // The legacy edge/ handlers return early when this lookup misses,
    // so every edge/+/{heartbeat,birth,death,response} test must see
    // a device here. Without this mock the entire "Edge device handlers"
    // suite silently swallows its events (ORPHAN-014).
    findByCodeOnly: jest
      .fn()
      .mockResolvedValue({ id: 'dev-1', tenantId: TENANT_ID, deviceCode: DEVICE_CODE }),
    updateDevice: jest.fn().mockResolvedValue(undefined),
    handlePingResponse: jest.fn(),
    handleScanHardwareResponse: jest.fn(),
    handleIoConfigAckResponse: jest.fn().mockReturnValue({ matched: false }),
    updateLoRaDeviceStatus: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<EdgeDeviceService>;
}

function createMockSensorTopicCache(): jest.Mocked<SensorTopicCacheService> {
  return {
    getSensorByTopic: jest.fn().mockResolvedValue(null),
    invalidateSensor: jest.fn().mockResolvedValue(undefined),
    invalidateTenant: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SensorTopicCacheService>;
}

function createMockEventBus() {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

function createSensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: SENSOR_ID,
    name: 'Test Sensor',
    type: 'temperature',
    tenantId: TENANT_ID,
    status: SensorStatus.ACTIVE,
    protocolConfiguration: {
      topic: `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
      payloadFormat: 'json',
    },
    metadata: {},
    siteId: null,
    departmentId: null,
    systemId: null,
    equipmentId: null,
    tankId: null,
    pondId: null,
    farmId: null,
    ...overrides,
  } as Sensor;
}

function createCachedSensorInfo(overrides: Partial<CachedSensorInfo> = {}): CachedSensorInfo {
  return {
    id: SENSOR_ID,
    name: 'Test Sensor',
    type: 'temperature',
    tenantId: TENANT_ID,
    schemaName: `tenant_${TENANT_ID.replace(/-/g, '').substring(0, 16)}`,
    protocolConfiguration: { topic: `sensors/${TENANT_ID}/${SENSOR_ID}/data` },
    ...overrides,
  };
}

function buildService(
  overrides: {
    configOverrides?: Record<string, string>;
    edgeDeviceService?: EdgeDeviceService | null;
    sensorTopicCache?: SensorTopicCacheService | null;
    mqttClient?: MqttClientService | null;
    eventBus?: any;
    scadaDeployLogService?: { updateStatus: jest.Mock } | null;
  } = {},
) {
  const configService = createMockConfigService(overrides.configOverrides);
  const sensorRepo = createMockSensorRepository();
  const dataSource = createMockDataSource();
  const edgeDeviceService =
    overrides.edgeDeviceService !== undefined
      ? overrides.edgeDeviceService
      : createMockEdgeDeviceService();
  const sensorTopicCache =
    overrides.sensorTopicCache !== undefined
      ? overrides.sensorTopicCache
      : createMockSensorTopicCache();
  const mqttClient =
    overrides.mqttClient !== undefined ? overrides.mqttClient : createMockMqttClient();
  const eventBus = overrides.eventBus !== undefined ? overrides.eventBus : createMockEventBus();

  // Construct service directly (bypass DI)
  const metricWriter = {
    writeImmediate: jest.fn().mockResolvedValue(undefined),
    writeManaged: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue({ tenantId: 'stub', committedRows: 0 }),
  };
  const service = new (MqttListenerService as any)(
    configService,
    sensorRepo,
    dataSource,
    metricWriter, // metricWriter (SensorMetricWriterService)
    eventBus,
    edgeDeviceService,
    sensorTopicCache,
    mqttClient,
    null, // deploymentLogService
    null, // automationService
    overrides.scadaDeployLogService ?? null, // scadaDeployLogService
  ) as MqttListenerService;

  return {
    service,
    configService,
    sensorRepo,
    dataSource,
    metricWriter,
    edgeDeviceService: edgeDeviceService as jest.Mocked<EdgeDeviceService> | null,
    sensorTopicCache: sensorTopicCache as jest.Mocked<SensorTopicCacheService> | null,
    mqttClient: mqttClient as jest.Mocked<MqttClientService> | null,
    eventBus,
  };
}

/**
 * Invoke the private handleMessage method via the bound messageHandler
 * stored in the constructor.
 */
async function callHandleMessage(
  service: MqttListenerService,
  topic: string,
  payload: string | Buffer,
): Promise<void> {
  const handler = (service as any).messageHandler as (topic: string, message: Buffer) => void;
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  // The bound handler now PROPAGATES rejections (SENSOR-CRITICAL-086): the
  // MQTT ack gate awaits them to hold PUBACK and force redelivery. We still
  // call handleMessage directly for per-error assertions.
  void handler;
  await (service as any).handleMessage(topic, buffer);
}

// ─── Test Suite ───────────────────────────────────────────────────────────

describe('MqttListenerService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==================== 1. Topic Parsing ====================

  describe('Topic parsing', () => {
    it('should parse sensors/{tenantId}/{sensorId}/data pattern correctly', async () => {
      const { service, sensorTopicCache, dataSource } = buildService();
      const cachedInfo = createCachedSensorInfo();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(cachedInfo);

      // Mock loadSensorFromCache
      const sensor = createSensor();
      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);

      await callHandleMessage(
        service,
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
        JSON.stringify({ temperature: 23.5 }),
      );

      expect(sensorTopicCache!.getSensorByTopic).toHaveBeenCalledWith(
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
      );
    });

    it('propagates a durable-write failure so the MQTT ack gate can redeliver (SENSOR-CRITICAL-086)', async () => {
      const { service, sensorTopicCache, dataSource, metricWriter } = buildService();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(createCachedSensorInfo());

      const sensor = createSensor();
      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);
      // One enabled channel so saveReading actually produces a metric row
      // and reaches the writer.
      const channelRepo = (qr.manager.getRepository as jest.Mock)();
      channelRepo.find.mockResolvedValueOnce([
        {
          id: '66666666-6666-4666-8666-666666666666',
          sensorId: SENSOR_ID,
          channelKey: 'temperature',
          dataPath: null,
          isEnabled: true,
          applyCalibration: (v: number) => v,
          validateValue: () => ({ valid: true, level: 'good' }),
        },
      ]);
      metricWriter.writeManaged.mockRejectedValueOnce(new Error('db down'));

      await expect(
        callHandleMessage(
          service,
          `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
          JSON.stringify({ temperature: 23.5 }),
        ),
      ).rejects.toThrow(/Durable metric write failed/);
    });

    it('publishes SensorReading with a deterministic eventId derived from the source reading (Task 1.4)', async () => {
      const { service, sensorTopicCache, dataSource, eventBus } = buildService();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(createCachedSensorInfo());

      const sensor = createSensor();
      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);
      const channelRepo = (qr.manager.getRepository as jest.Mock)();
      channelRepo.find.mockResolvedValue([
        {
          id: '66666666-6666-4666-8666-666666666666',
          sensorId: SENSOR_ID,
          channelKey: 'temperature',
          dataPath: null,
          isEnabled: true,
          applyCalibration: (v: number) => v,
          validateValue: () => ({ valid: true, level: 'good' }),
        },
      ]);

      const publish = eventBus.publish as jest.Mock;
      const readingEvents = (): Array<Record<string, unknown>> =>
        publish.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .filter((e) => e['eventType'] === 'SensorReading');

      // Same payload (with its own producer ts) handled twice → ONE identity.
      const payload = JSON.stringify({ temperature: 23.5, ts: 1_730_000_000_000 });
      await callHandleMessage(service, `sensors/${TENANT_ID}/${SENSOR_ID}/data`, payload);
      await callHandleMessage(service, `sensors/${TENANT_ID}/${SENSOR_ID}/data`, payload);
      expect(readingEvents()).toHaveLength(2);
      expect(readingEvents()[0]!['eventId']).toBe(readingEvents()[1]!['eventId']);
      expect(readingEvents()[0]!['eventId']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // A different payload is a different logical event.
      await callHandleMessage(
        service,
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
        JSON.stringify({ temperature: 24.0, ts: 1_730_000_000_000 }),
      );
      expect(readingEvents()).toHaveLength(3);
      expect(readingEvents()[2]!['eventId']).not.toBe(readingEvents()[0]!['eventId']);
    });

    it('should parse aquaculture/{tenantId}/sensors/{sensorId} pattern correctly', async () => {
      const { service, sensorTopicCache, dataSource } = buildService();
      const topic = `aquaculture/${TENANT_ID}/sensors/${SENSOR_ID}`;
      const cachedInfo = createCachedSensorInfo({ protocolConfiguration: { topic } });
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(cachedInfo);

      const sensor = createSensor({ protocolConfiguration: { topic, payloadFormat: 'json' } });
      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);

      await callHandleMessage(service, topic, JSON.stringify({ ph: 7.2 }));

      expect(sensorTopicCache!.getSensorByTopic).toHaveBeenCalledWith(topic);
    });

    it('should route tenants/{tenantId}/devices/{deviceCode}/telemetry to tenant-prefixed handler', async () => {
      const { service, edgeDeviceService } = buildService();
      const topic = `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/telemetry`;
      const payload = JSON.stringify({ cpu_usage_percent: 45.2, memory_usage_percent: 60.1 });

      await callHandleMessage(service, topic, payload);

      expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceCode: DEVICE_CODE,
          tenantId: TENANT_ID,
          isOnline: true,
          cpuUsage: 45,
          memoryUsage: 60,
        }),
      );
    });

    it('should skip messages with invalid/unparseable topics (too few parts)', async () => {
      const { service, sensorTopicCache } = buildService();
      // A topic with only 2 parts will return null from parseTopic
      // and sensorTopicCache returns null -> no sensor found, message is dropped
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(null);

      await callHandleMessage(service, 'a/b', JSON.stringify({ value: 1 }));

      // No error thrown, message simply skipped
      expect(sensorTopicCache!.getSensorByTopic).toHaveBeenCalledWith('a/b');
    });
  });

  // ==================== 2. Payload Validation ====================

  describe('Payload validation', () => {
    it('should process valid JSON payload', async () => {
      const { service, sensorTopicCache, dataSource } = buildService();
      const sensor = createSensor();
      const cachedInfo = createCachedSensorInfo();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(cachedInfo);

      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);

      await callHandleMessage(
        service,
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
        JSON.stringify({ temperature: 23.5 }),
      );

      // If sensor is found, saveReading is called (channels are empty so no metrics inserted)
      // No error should be thrown
      expect(sensorTopicCache!.getSensorByTopic).toHaveBeenCalled();
    });

    it('should log warning and skip on invalid JSON payload', async () => {
      const { service, sensorTopicCache, dataSource } = buildService();
      const sensor = createSensor();
      const cachedInfo = createCachedSensorInfo();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(cachedInfo);

      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);

      // Invalid JSON
      const loggerSpy = jest.spyOn((service as any).logger, 'warn');

      await callHandleMessage(service, `sensors/${TENANT_ID}/${SENSOR_ID}/data`, '{not valid json');

      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse payload'));
    });

    it('should reject payload exceeding 256KB size limit', async () => {
      const { service } = buildService();
      const loggerSpy = jest.spyOn((service as any).logger, 'warn');

      // Create payload > 256KB
      const largePayload = Buffer.alloc(256 * 1024 + 1, 'A');

      await callHandleMessage(service, `sensors/${TENANT_ID}/${SENSOR_ID}/data`, largePayload);

      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Payload too large'));
    });

    it('should skip empty payload (parsePayload returns null for invalid JSON)', async () => {
      const { service, sensorTopicCache, dataSource } = buildService();
      const sensor = createSensor();
      const cachedInfo = createCachedSensorInfo();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(cachedInfo);

      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);

      const loggerSpy = jest.spyOn((service as any).logger, 'warn');

      await callHandleMessage(service, `sensors/${TENANT_ID}/${SENSOR_ID}/data`, '');

      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
    });

    it('should accept payload exactly at 256KB limit', async () => {
      const { service, sensorTopicCache } = buildService();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(null);

      // Create payload exactly 256KB - should NOT be rejected
      const exactPayload = Buffer.alloc(256 * 1024, 'A');

      const loggerSpy = jest.spyOn((service as any).logger, 'warn');

      await callHandleMessage(service, `sensors/${TENANT_ID}/${SENSOR_ID}/data`, exactPayload);

      // Should not see "Payload too large" warning
      const payloadTooLargeCalls = loggerSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Payload too large'),
      );
      expect(payloadTooLargeCalls).toHaveLength(0);
    });
  });

  // ==================== 3. Legacy Topic Deprecation ====================

  describe('Legacy topic deprecation', () => {
    it('should process legacy edge/ topics with deprecation warning when LEGACY_EDGE_TOPICS_ENABLED=true', async () => {
      const { service, edgeDeviceService } = buildService({
        configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
      });

      const loggerSpy = jest.spyOn((service as any).logger, 'warn');

      await callHandleMessage(
        service,
        `edge/${DEVICE_CODE}/heartbeat`,
        JSON.stringify({ cpuUsage: 45, memoryUsage: 60, isOnline: true }),
      );

      // Should log deprecation warning
      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('[DEPRECATED]'));

      // Should still process the message
      expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalled();
    });

    it('should skip legacy edge/ topics with warning when LEGACY_EDGE_TOPICS_ENABLED=false', async () => {
      const { service, edgeDeviceService } = buildService({
        configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'false' },
      });

      const loggerSpy = jest.spyOn((service as any).logger, 'warn');

      await callHandleMessage(
        service,
        `edge/${DEVICE_CODE}/heartbeat`,
        JSON.stringify({ cpuUsage: 45 }),
      );

      // Should log that legacy topics are disabled
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Legacy edge/ topics are disabled'),
      );

      // Should NOT process the message
      expect(edgeDeviceService!.updateHeartbeat).not.toHaveBeenCalled();
    });
  });

  // ==================== 4. Sensor Lookup ====================

  describe('Sensor lookup', () => {
    it('should use cached sensor info on cache hit', async () => {
      const { service, sensorTopicCache, dataSource } = buildService();
      const cachedInfo = createCachedSensorInfo();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(cachedInfo);

      const sensor = createSensor();
      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);

      await callHandleMessage(
        service,
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
        JSON.stringify({ value: 1 }),
      );

      expect(sensorTopicCache!.getSensorByTopic).toHaveBeenCalledTimes(1);
      // loadSensorFromCache should be called (via createQueryRunner)
      expect(dataSource.createQueryRunner).toHaveBeenCalled();
    });

    it('should return null when cache returns null (cache miss with no DB result)', async () => {
      const { service, sensorTopicCache, dataSource } = buildService();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(null);

      const loggerSpy = jest.spyOn((service as any).logger, 'debug');

      await callHandleMessage(
        service,
        'sensors/unknown-tenant/unknown-sensor/data',
        JSON.stringify({ value: 1 }),
      );

      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('No sensor found for topic'));
    });

    it('should fall back to legacy cross-schema search when cache service is unavailable', async () => {
      const { service, dataSource } = buildService({ sensorTopicCache: null });

      // Mock the legacy path: dataSource.query returns tenant schemas
      dataSource.query.mockResolvedValueOnce([{ schema_name: 'tenant_aaaaaaaaaaaa4aaa' }]);

      // Mock createQueryRunner for legacy path
      const qr = dataSource.createQueryRunner();
      // table check returns table exists
      (qr.query as jest.Mock)
        .mockResolvedValueOnce(undefined) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce(undefined) // transaction-local search_path pin
        .mockResolvedValueOnce([{ '1': 1 }]); // table check

      await callHandleMessage(
        service,
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
        JSON.stringify({ value: 1 }),
      );

      // Should have queried for tenant schemas
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.schemata'),
      );
    });

    it('should populate negative cache for unknown topics (legacy path)', async () => {
      const { service, dataSource } = buildService({ sensorTopicCache: null });

      // Mock the legacy path: no tenant schemas -> no sensor found
      dataSource.query.mockResolvedValue([]);

      const loggerSpy = jest.spyOn((service as any).logger, 'warn');

      await callHandleMessage(
        service,
        'sensors/nonexistent/sensor/data',
        JSON.stringify({ value: 1 }),
      );

      // Should have populated negative cache
      const negativeCache = (service as any).topicNegativeCache as Map<string, number>;
      expect(negativeCache.has('sensors/nonexistent/sensor/data')).toBe(true);
    });
  });

  // ==================== 5. Tenant Isolation ====================

  describe('Tenant isolation', () => {
    it('should process message when sensor tenantId matches topic tenantId', async () => {
      const { service, sensorTopicCache, dataSource } = buildService();
      const cachedInfo = createCachedSensorInfo({ tenantId: TENANT_ID });
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(cachedInfo);

      const sensor = createSensor({ tenantId: TENANT_ID });
      const qr = dataSource.createQueryRunner();
      (qr.manager.findOne as jest.Mock).mockResolvedValue(sensor);

      // Should process without error
      await callHandleMessage(
        service,
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
        JSON.stringify({ value: 1 }),
      );

      expect(sensorTopicCache!.getSensorByTopic).toHaveBeenCalled();
    });

    it('should pass tenantId from topic to edge device heartbeat for tenant boundary enforcement', async () => {
      const { service, edgeDeviceService } = buildService();
      const otherTenantId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      const topic = `tenants/${otherTenantId}/devices/${DEVICE_CODE}/telemetry`;

      await callHandleMessage(
        service,
        topic,
        JSON.stringify({ cpu_usage_percent: 30, memory_usage_percent: 50 }),
      );

      // tenantId from topic should be passed to updateHeartbeat
      expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: otherTenantId,
          deviceCode: DEVICE_CODE,
        }),
      );
    });
  });

  // ==================== 6. Message Routing ====================

  describe('Message routing', () => {
    it('should route edge/ prefix to legacy handler', async () => {
      const { service, edgeDeviceService } = buildService({
        configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
      });

      await callHandleMessage(
        service,
        `edge/${DEVICE_CODE}/heartbeat`,
        JSON.stringify({ cpuUsage: 10, isOnline: true }),
      );

      expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ deviceCode: DEVICE_CODE }),
      );
    });

    it('should route tenants/ prefix to tenant-prefixed handler', async () => {
      const { service, edgeDeviceService } = buildService();

      await callHandleMessage(
        service,
        `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/status`,
        JSON.stringify({ online: true, status: 'online' }),
      );

      expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceCode: DEVICE_CODE,
          tenantId: TENANT_ID,
          isOnline: true,
        }),
      );
    });

    it('should route sensor data topics to sensor data handler', async () => {
      const { service, sensorTopicCache } = buildService();
      sensorTopicCache!.getSensorByTopic.mockResolvedValue(null);

      await callHandleMessage(
        service,
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
        JSON.stringify({ temperature: 25 }),
      );

      // Should have tried to look up sensor via cache
      expect(sensorTopicCache!.getSensorByTopic).toHaveBeenCalledWith(
        `sensors/${TENANT_ID}/${SENSOR_ID}/data`,
      );
    });
  });

  // ==================== 7. Edge Device Handlers ====================

  describe('Edge device handlers', () => {
    describe('Legacy edge/ handlers', () => {
      it('should handle edge/{deviceCode}/heartbeat', async () => {
        const { service, edgeDeviceService } = buildService({
          configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
        });

        await callHandleMessage(
          service,
          `edge/${DEVICE_CODE}/heartbeat`,
          JSON.stringify({
            cpuUsage: 55,
            memoryUsage: 70,
            storageUsage: 40,
            temperatureCelsius: 42,
            isOnline: true,
          }),
        );

        expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
          expect.objectContaining({
            deviceCode: DEVICE_CODE,
            isOnline: true,
            cpuUsage: 55,
            memoryUsage: 70,
            storageUsage: 40,
            temperatureCelsius: 42,
          }),
        );
      });

      it('should handle edge/{deviceCode}/birth', async () => {
        const { service, edgeDeviceService } = buildService({
          configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
        });

        await callHandleMessage(
          service,
          `edge/${DEVICE_CODE}/birth`,
          JSON.stringify({ firmwareVersion: '2.0.1', ipAddress: '192.168.1.100' }),
        );

        expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
          expect.objectContaining({
            deviceCode: DEVICE_CODE,
            isOnline: true,
            firmwareVersion: '2.0.1',
            ipAddress: '192.168.1.100',
          }),
        );
      });

      it('should handle edge/{deviceCode}/death', async () => {
        const { service, edgeDeviceService } = buildService({
          configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
        });

        await callHandleMessage(service, `edge/${DEVICE_CODE}/death`, JSON.stringify({}));

        expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
          expect.objectContaining({
            deviceCode: DEVICE_CODE,
            isOnline: false,
          }),
        );
      });

      it('should handle edge/{deviceCode}/response and edge/{deviceCode}/responses', async () => {
        const { service, edgeDeviceService, eventBus } = buildService({
          configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
        });

        await callHandleMessage(
          service,
          `edge/${DEVICE_CODE}/response`,
          JSON.stringify({ commandId: 'cmd-1', success: true }),
        );

        expect(edgeDeviceService!.handlePingResponse).toHaveBeenCalledWith(
          DEVICE_CODE,
          expect.objectContaining({ commandId: 'cmd-1', success: true }),
        );
        expect(eventBus.publish).toHaveBeenCalledWith(
          expect.objectContaining({ eventType: 'EdgeDeviceResponse' }),
        );
      });

      it('should skip edge device messages when EdgeDeviceService is not available', async () => {
        const { service } = buildService({
          configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
          edgeDeviceService: null,
        });

        const loggerSpy = jest.spyOn((service as any).logger, 'warn');

        await callHandleMessage(
          service,
          `edge/${DEVICE_CODE}/heartbeat`,
          JSON.stringify({ cpuUsage: 10 }),
        );

        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('EdgeDeviceService not available'),
        );
      });

      it('should warn on invalid edge topic format (too few parts)', async () => {
        const { service, edgeDeviceService } = buildService({
          configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
        });

        const loggerSpy = jest.spyOn((service as any).logger, 'warn');

        await callHandleMessage(service, 'edge/only', JSON.stringify({}));

        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid edge device topic format'),
        );
        expect(edgeDeviceService!.updateHeartbeat).not.toHaveBeenCalled();
      });

      it('should log error on invalid JSON in edge message', async () => {
        const { service } = buildService({
          configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
        });

        const loggerSpy = jest.spyOn((service as any).logger, 'error');

        await callHandleMessage(service, `edge/${DEVICE_CODE}/heartbeat`, 'not-json');

        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to parse edge device message'),
        );
      });
    });

    describe('Tenant-prefixed edge handlers', () => {
      it('should handle tenants/{tid}/devices/{code}/telemetry with nested metrics', async () => {
        const { service, edgeDeviceService } = buildService();

        // Edge Agent v2.0 format with nested metrics
        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/telemetry`,
          JSON.stringify({
            device_id: 'dev-1',
            device_code: DEVICE_CODE,
            timestamp: '2026-03-14T10:00:00Z',
            metrics: {
              cpu_usage_percent: 15.5,
              memory_usage_percent: 25.0,
              disk_usage_percent: 40.0,
              temperature_celsius: 45.2,
              uptime_secs: 86400,
            },
          }),
        );

        expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
          expect.objectContaining({
            deviceCode: DEVICE_CODE,
            tenantId: TENANT_ID,
            isOnline: true,
            cpuUsage: 16, // Math.round(15.5)
            memoryUsage: 25,
            storageUsage: 40,
            temperatureCelsius: 45.2,
            uptimeSeconds: 86400,
          }),
        );
      });

      it('should handle tenants/{tid}/devices/{code}/status online', async () => {
        const { service, edgeDeviceService } = buildService();

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/status`,
          JSON.stringify({ online: true, status: 'online', agent_version: '2.3.0' }),
        );

        expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
          expect.objectContaining({
            deviceCode: DEVICE_CODE,
            tenantId: TENANT_ID,
            isOnline: true,
            status: 'online',
            firmwareVersion: '2.3.0',
          }),
        );
      });

      it('should handle tenants/{tid}/devices/{code}/status offline', async () => {
        const { service, edgeDeviceService } = buildService();

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/status`,
          JSON.stringify({ online: false, status: 'offline' }),
        );

        expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalledWith(
          expect.objectContaining({
            deviceCode: DEVICE_CODE,
            tenantId: TENANT_ID,
            isOnline: false,
            status: 'offline',
          }),
        );
      });

      it('should handle tenants/{tid}/devices/{code}/response', async () => {
        const { service, edgeDeviceService, eventBus } = buildService();

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/response`,
          JSON.stringify({ commandId: 'cmd-123', success: true, command: 'ping' }),
        );

        expect(edgeDeviceService!.handlePingResponse).toHaveBeenCalledWith(
          DEVICE_CODE,
          expect.objectContaining({ commandId: 'cmd-123' }),
        );
        expect(eventBus.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'EdgeDeviceResponse',
            tenantId: TENANT_ID,
            deviceCode: DEVICE_CODE,
          }),
        );
      });

      it('should handle tenants/{tid}/devices/{code}/io_data with valid tags', async () => {
        const { service, eventBus, edgeDeviceService } = buildService();
        edgeDeviceService!.findByCode.mockResolvedValue(null); // skip persist

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/io_data`,
          JSON.stringify({
            timestamp: '2026-03-14T12:00:00Z',
            tags: {
              pump1_run: { value: true, quality: 'good' },
              temp_inlet: { value: 23.5, quality: 'good' },
            },
          }),
        );

        expect(eventBus.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'EdgeDeviceIoData',
            tenantId: TENANT_ID,
            deviceCode: DEVICE_CODE,
          }),
        );
      });

      // SENSOR-HIGH-074: the device lookup that gates io_data + alarm
      // persistence must run inside a tenant context, otherwise the per-tenant
      // edge_devices query hits the empty source-schema template, returns null,
      // and both writes are silently dropped.
      it('resolves the edge device inside a tenant context for io_data persistence', async () => {
        const { service, edgeDeviceService } = buildService();
        let lookupTenantId: string | undefined = 'NOT_CALLED_IN_CONTEXT';
        edgeDeviceService!.findByCode.mockImplementation(async () => {
          lookupTenantId = getRequestContext().tenantId;
          return null;
        });

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/io_data`,
          JSON.stringify({
            timestamp: '2026-03-14T12:00:00Z',
            tags: { temp_inlet: { value: 23.5, quality: 'good' } },
          }),
        );

        expect(edgeDeviceService!.findByCode).toHaveBeenCalledWith(DEVICE_CODE, TENANT_ID);
        expect(lookupTenantId).toBe(TENANT_ID);
      });

      it('resolves the edge device inside a tenant context for alarm persistence', async () => {
        const { service, edgeDeviceService } = buildService();
        let lookupTenantId: string | undefined = 'NOT_CALLED_IN_CONTEXT';
        edgeDeviceService!.findByCode.mockImplementation(async () => {
          lookupTenantId = getRequestContext().tenantId;
          return null;
        });

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/alarms`,
          JSON.stringify({
            timestamp: '2026-03-14T12:00:00Z',
            alarms: [
              { tag: 'temp_inlet', type: 'HIGH', priority: 'high', value: 99, setpoint: 80 },
            ],
          }),
        );

        expect(lookupTenantId).toBe(TENANT_ID);
      });

      it('should reject io_data with payload exceeding 64KB', async () => {
        const { service, eventBus } = buildService();
        const loggerSpy = jest.spyOn((service as any).logger, 'warn');

        // Create tags object that exceeds 64KB when serialized
        const tags: Record<string, any> = {};
        for (let i = 0; i < 1000; i++) {
          tags[`tag_${i}_${'x'.repeat(60)}`] = { value: i, quality: 'good' };
        }

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/io_data`,
          JSON.stringify({ tags }),
        );

        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('I/O data payload too large'),
        );
        expect(eventBus.publish).not.toHaveBeenCalledWith(
          expect.objectContaining({ eventType: 'EdgeDeviceIoData' }),
        );
      });

      it('should reject io_data with more than 256 tags', async () => {
        const { service, eventBus } = buildService();
        const loggerSpy = jest.spyOn((service as any).logger, 'warn');

        const tags: Record<string, any> = {};
        for (let i = 0; i < 257; i++) {
          tags[`t${i}`] = { value: i, quality: 'good' };
        }

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/io_data`,
          JSON.stringify({ tags }),
        );

        expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('has 257 tags'));
      });

      it('should reject io_data with missing/invalid tags structure', async () => {
        const { service, eventBus } = buildService();
        const loggerSpy = jest.spyOn((service as any).logger, 'warn');

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/io_data`,
          JSON.stringify({ no_tags: 'here' }),
        );

        expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('invalid structure'));
      });

      it('should handle tenants/{tid}/devices/{code}/alarms', async () => {
        const { service, eventBus, dataSource, edgeDeviceService } = buildService();
        edgeDeviceService!.findByCode.mockResolvedValue(null); // getCachedDevice returns null -> skip persist

        // Clear device cache so findByCode is called
        (service as any).deviceCache.clear();

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/alarms`,
          JSON.stringify({
            timestamp: '2026-03-14T12:00:00Z',
            alarms: [
              {
                tag: 'temp_inlet',
                type: 'HH',
                priority: 'critical',
                state: 'active',
                value: 32.5,
                setpoint: 30.0,
              },
            ],
          }),
        );

        expect(eventBus.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'EdgeDeviceAlarm',
            tenantId: TENANT_ID,
          }),
        );
      });

      it('should handle tenants/{tid}/devices/{code}/capabilities', async () => {
        const { service, edgeDeviceService } = buildService();

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/capabilities`,
          JSON.stringify({
            platform: 'linux_arm64',
            gpio_chip_count: 2,
            total_gpio_lines: 40,
            has_picontrol: false,
            rppal_available: true,
          }),
        );

        expect(edgeDeviceService!.findByCode).toHaveBeenCalledWith(DEVICE_CODE, TENANT_ID);
        expect(edgeDeviceService!.updateDevice).toHaveBeenCalledWith(
          'dev-1',
          TENANT_ID,
          expect.objectContaining({
            capabilities: expect.objectContaining({
              hasGpio: true,
              hasPicontrol: false,
              hasRppal: true,
            }),
          }),
        );
      });

      it('should handle tenants/{tid}/devices/{code}/lora_events (join_accept)', async () => {
        const { service, edgeDeviceService, eventBus } = buildService();

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/lora_events`,
          JSON.stringify({
            event_type: 'join_accept',
            dev_eui: '0011223344556677',
            dev_addr: '26011234',
          }),
        );

        expect(edgeDeviceService!.updateLoRaDeviceStatus).toHaveBeenCalledWith(
          '0011223344556677',
          expect.objectContaining({
            isJoined: true,
            devAddr: '26011234',
          }),
        );
        expect(eventBus.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'LoRaDeviceEvent',
            loraEventType: 'join_accept',
          }),
        );
      });

      it('should handle tenants/{tid}/devices/{code}/lora_events (uplink_summary)', async () => {
        const { service, edgeDeviceService } = buildService();

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/lora_events`,
          JSON.stringify({
            event_type: 'uplink_summary',
            dev_eui: '0011223344556677',
            rssi: -65,
            snr: 8.5,
            frame_count_up: 42,
          }),
        );

        expect(edgeDeviceService!.updateLoRaDeviceStatus).toHaveBeenCalledWith(
          '0011223344556677',
          expect.objectContaining({
            lastRssi: -65,
            lastSnr: 8.5,
            frameCountUp: 42,
          }),
        );
      });

      it('should warn on invalid tenant-prefixed topic format (too few parts)', async () => {
        const { service } = buildService();
        const loggerSpy = jest.spyOn((service as any).logger, 'warn');

        await callHandleMessage(service, 'tenants/abc/only', JSON.stringify({}));

        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid tenant-prefixed topic format'),
        );
      });

      it('should log error on invalid JSON in tenant-prefixed message', async () => {
        const { service } = buildService();
        const loggerSpy = jest.spyOn((service as any).logger, 'error');

        await callHandleMessage(
          service,
          `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/telemetry`,
          '{broken',
        );

        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to parse tenant-prefixed message'),
        );
      });
    });
  });

  // ==================== 8. Module Lifecycle ====================

  describe('Module lifecycle', () => {
    it('should register message handler and subscribe on init when MQTT is connected', async () => {
      const { service, mqttClient } = buildService();

      await (service as any).onModuleInit();

      expect(mqttClient!.addMessageHandler).toHaveBeenCalled();
      expect(mqttClient!.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining(['sensors/#', 'aquaculture/+/sensors/#']),
      );
    });

    it('should not start when MQTT_ENABLED=false', async () => {
      const { service, mqttClient } = buildService({
        configOverrides: { MQTT_ENABLED: 'false' },
      });

      await (service as any).onModuleInit();

      expect(mqttClient!.addMessageHandler).not.toHaveBeenCalled();
    });

    it('should not subscribe to legacy edge/ topics when LEGACY_EDGE_TOPICS_ENABLED=false', async () => {
      const { service, mqttClient } = buildService({
        configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'false' },
      });

      await (service as any).onModuleInit();

      // Check the subscribe call arguments
      if (mqttClient!.subscribe.mock.calls.length > 0) {
        const callArgs = mqttClient!.subscribe.mock.calls[0];
        const subscribedTopics = (callArgs ? callArgs[0] : []) as string[];
        expect(subscribedTopics).not.toContain('edge/+/heartbeat');
        expect(subscribedTopics).not.toContain('edge/+/birth');
        expect(subscribedTopics).not.toContain('edge/+/death');
      }
    });

    it('should subscribe to legacy edge/ topics when LEGACY_EDGE_TOPICS_ENABLED=true', async () => {
      const { service, mqttClient } = buildService({
        configOverrides: { LEGACY_EDGE_TOPICS_ENABLED: 'true' },
      });

      await (service as any).onModuleInit();

      if (mqttClient!.subscribe.mock.calls.length > 0) {
        const callArgs = mqttClient!.subscribe.mock.calls[0];
        const subscribedTopics = (callArgs ? callArgs[0] : []) as string[];
        expect(subscribedTopics).toContain('edge/+/heartbeat');
        expect(subscribedTopics).toContain('edge/+/birth');
      }
    });

    it('should remove message handler and flush lastSeen on destroy', async () => {
      const { service, mqttClient, sensorRepo } = buildService();

      // Seed a pending lastSeenAt entry
      (service as any).lastSeenPending.set(SENSOR_ID, new Date());

      await (service as any).onModuleDestroy();

      expect(mqttClient!.removeMessageHandler).toHaveBeenCalled();
    });

    it('should use onceConnected callback when MQTT not yet connected', async () => {
      const mockMqttClient = createMockMqttClient();
      mockMqttClient.isConnectedToBroker.mockReturnValue(false);

      const { service } = buildService({ mqttClient: mockMqttClient });

      await (service as any).onModuleInit();

      expect(mockMqttClient.onceConnected).toHaveBeenCalled();
      // subscribe should NOT have been called yet (not connected)
      expect(mockMqttClient.subscribe).not.toHaveBeenCalled();
    });
  });

  // ==================== 9. Payload Format Handling ====================

  describe('Payload format handling', () => {
    it('should handle CSV payload format', async () => {
      const { service } = buildService();
      const sensor = createSensor({
        protocolConfiguration: { payloadFormat: 'csv', topic: 'test' },
      });

      const result = (service as any).parsePayload('23.5,7.2,8.1', sensor);

      expect(result).toEqual({
        value_0: 23.5,
        value_1: 7.2,
        value_2: 8.1,
      });
    });

    it('should handle text payload format (numeric)', async () => {
      const { service } = buildService();
      const sensor = createSensor({
        protocolConfiguration: { payloadFormat: 'text', topic: 'test' },
      });

      const result = (service as any).parsePayload('42.7', sensor);

      expect(result).toEqual({ value: 42.7 });
    });

    it('should handle text payload format (non-numeric)', async () => {
      const { service } = buildService();
      const sensor = createSensor({
        protocolConfiguration: { payloadFormat: 'text', topic: 'test' },
      });

      const result = (service as any).parsePayload('hello-world', sensor);

      expect(result).toEqual({ raw: 'hello-world' });
    });

    it('should default to JSON parsing for unknown format', async () => {
      const { service } = buildService();
      const sensor = createSensor({
        protocolConfiguration: { payloadFormat: 'unknown', topic: 'test' },
      });

      const result = (service as any).parsePayload('{"value": 1}', sensor);
      expect(result).toEqual({ value: 1 });
    });
  });

  // ==================== 10. Topic Wildcard Matching ====================

  describe('Topic wildcard matching', () => {
    it('should match single-level wildcard (+)', () => {
      const service = buildService().service;
      const topicMatches = (service as any).topicMatches.bind(service);

      expect(topicMatches('sensors/+/data', 'sensors/abc/data')).toBe(true);
      expect(topicMatches('sensors/+/data', 'sensors/abc/other')).toBe(false);
    });

    it('should match multi-level wildcard (#)', () => {
      const service = buildService().service;
      const topicMatches = (service as any).topicMatches.bind(service);

      expect(topicMatches('sensors/#', 'sensors/a/b/c')).toBe(true);
      expect(topicMatches('sensors/#', 'sensors')).toBe(true);
    });

    it('should not match when pattern has more parts than topic', () => {
      const service = buildService().service;
      const topicMatches = (service as any).topicMatches.bind(service);

      expect(topicMatches('sensors/a/b/c', 'sensors/a')).toBe(false);
    });

    it('should match exact topic without wildcards', () => {
      const service = buildService().service;
      const topicMatches = (service as any).topicMatches.bind(service);

      expect(topicMatches('sensors/abc/data', 'sensors/abc/data')).toBe(true);
      expect(topicMatches('sensors/abc/data', 'sensors/xyz/data')).toBe(false);
    });
  });

  // ==================== 11. I/O Data Throttle ====================

  describe('I/O data throttle', () => {
    it('should throttle io_data messages from the same device within 1 second', async () => {
      const { service, eventBus, edgeDeviceService } = buildService();
      edgeDeviceService!.findByCode.mockResolvedValue(null);

      const topic = `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/io_data`;
      const payload = JSON.stringify({
        tags: { pump1: { value: true, quality: 'good' } },
      });

      // First message should pass
      await callHandleMessage(service, topic, payload);
      expect(eventBus.publish).toHaveBeenCalledTimes(1);

      // Second message within throttle window should be skipped
      await callHandleMessage(service, topic, payload);
      expect(eventBus.publish).toHaveBeenCalledTimes(1); // still 1
    });
  });

  // ==================== 12. Value Extraction ====================

  describe('Value extraction', () => {
    it('should extract nested values using dot notation', () => {
      const service = buildService().service;
      const extractValue = (service as any).extractValue.bind(service);

      expect(extractValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
    });

    it('should extract array values using bracket notation', () => {
      const service = buildService().service;
      const extractValue = (service as any).extractValue.bind(service);

      expect(extractValue({ data: [10, 20, 30] }, 'data[1]')).toBe(20);
    });

    it('should return undefined for non-existent paths', () => {
      const service = buildService().service;
      const extractValue = (service as any).extractValue.bind(service);

      expect(extractValue({ a: 1 }, 'b.c')).toBeUndefined();
    });
  });

  // ==================== 13. Event Publishing ====================

  describe('Event publishing', () => {
    it('should publish EdgeDeviceHeartbeat event on heartbeat', async () => {
      const { service, eventBus } = buildService();

      await callHandleMessage(
        service,
        `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/telemetry`,
        JSON.stringify({ cpu_usage_percent: 10 }),
      );

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'EdgeDeviceHeartbeat',
          tenantId: TENANT_ID,
        }),
      );
    });

    it('should not publish events when eventBus is null', async () => {
      const { service, edgeDeviceService } = buildService({ eventBus: null });

      // Should not throw
      await callHandleMessage(
        service,
        `tenants/${TENANT_ID}/devices/${DEVICE_CODE}/telemetry`,
        JSON.stringify({ cpu_usage_percent: 10 }),
      );

      expect(edgeDeviceService!.updateHeartbeat).toHaveBeenCalled();
    });
  });

  // UUID (and non-finite) metric validation moved to SensorMetricWriterService
  // (SENSOR-MEDIUM-068) — see sensor-metric-writer.service.spec.ts.

  // ==================== 15. Alarm Priority Mapping ====================

  describe('Alarm priority mapping', () => {
    it('should map alarm priorities to correct severities', () => {
      const service = buildService().service;
      const mapPriority = (service as any).mapAlarmPriorityToSeverity.bind(service);

      expect(mapPriority('critical')).toBe('critical');
      expect(mapPriority('high')).toBe('error');
      expect(mapPriority('medium')).toBe('warning');
      expect(mapPriority('low')).toBe('info');
      expect(mapPriority('unknown')).toBe('info');
    });
  });

  // ==================== 16. SCADA undeploy ack routing (WF-011) ====================

  describe('SCADA undeploy ack routing (WF-011)', () => {
    const responseTopic = `tenants/${TENANT_ID}/devices/EDGE-01/response`;

    it('routes a successful undeploy ack to UNDEPLOYED', async () => {
      const updateStatus = jest.fn().mockResolvedValue({});
      const { service } = buildService({ scadaDeployLogService: { updateStatus } });

      await callHandleMessage(
        service,
        responseTopic,
        JSON.stringify({
          command: 'undeploy_scada_package',
          commandId: 'cmd-undeploy-1',
          success: true,
        }),
      );

      expect(updateStatus).toHaveBeenCalledWith(
        'cmd-undeploy-1',
        'undeployed',
        undefined,
        TENANT_ID,
      );
    });

    it('routes a failed undeploy ack to FAILED with the device error', async () => {
      const updateStatus = jest.fn().mockResolvedValue({});
      const { service } = buildService({ scadaDeployLogService: { updateStatus } });

      await callHandleMessage(
        service,
        responseTopic,
        JSON.stringify({
          command: 'undeploy_scada_package',
          commandId: 'cmd-undeploy-2',
          success: false,
          error: 'clear failed',
        }),
      );

      expect(updateStatus).toHaveBeenCalledWith(
        'cmd-undeploy-2',
        'failed',
        { errorMessage: 'clear failed' },
        TENANT_ID,
      );
    });

    it('a deploy ack never lands in the undeploy branch (command-keyed routing)', async () => {
      const updateStatus = jest.fn().mockResolvedValue({});
      const { service } = buildService({ scadaDeployLogService: { updateStatus } });

      await callHandleMessage(
        service,
        responseTopic,
        JSON.stringify({
          command: 'deploy_scada_package',
          commandId: 'cmd-deploy-1',
          success: true,
        }),
      );

      expect(updateStatus).toHaveBeenCalledWith('cmd-deploy-1', 'success', undefined, TENANT_ID);
      expect(updateStatus).not.toHaveBeenCalledWith(
        'cmd-deploy-1',
        'undeployed',
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
