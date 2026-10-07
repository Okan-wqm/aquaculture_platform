import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { decodeSensorReadingId } from '@aquaculture/backend-common/sensor';
import { OutboxPublisher } from '@platform/outbox';
import type { ObjectLiteral, Repository } from 'typeorm';
import { createMockRepository, createTenantSessionDataSource } from '@platform/testing';

import { SensorDataChannel } from '../../../database/entities/sensor-data-channel.entity';
import { SensorReadings } from '../../../database/entities/sensor-reading.entity';
import { Sensor } from '../../../database/entities/sensor.entity';
import { SensorMetricWriterService } from '../../../ingestion/sensor-metric-writer.service';
import { CalibrationService } from '../calibration.service';
import { DataQualityService } from '../data-quality.service';
import { ReadingMapperRegistry } from '../reading-mapper.service';
import { SensorIngestionService, IngestReadingData } from '../sensor-ingestion.service';

/**
 * SensorIngestionService — transactional outbox durability (SENSOR-CRITICAL-001)
 * over the as-of projection store (SENSOR-HIGH-085).
 *
 * A reading is no longer persisted as a sensor_readings row: the SensorReading
 * event AND the channel-keyed sensor_metrics rows are derived from the in-memory
 * reading and enqueued/written on the SAME transactional manager. This suite
 * pins that (a) no stored-row write happens, (b) the event + metric writes are
 * atomic on one manager, and (c) the returned reading carries the as-of codec id.
 */
describe('SensorIngestionService — outbox durability', () => {
  let service: SensorIngestionService;

  const TENANT_ID = '11111111-1111-4111-8111-111111111111';

  // Every read and write runs inside runInTenantTransaction / runInTenantRead:
  // a session that honours the boundary's own statements, so a statement run
  // under the wrong tenant (or none) is visible here exactly as it would be
  // against Postgres (SENSOR-HIGH-145/148). `boundTenants` records the tenant
  // each transaction was bound to when it committed. `transactionManager` is
  // the identity the atomicity assertions match against.
  const {
    mockDataSource,
    mockManager: transactionManager,
    session,
    boundTenants,
    queryBuilders,
  } = createTenantSessionDataSource();
  /** The tenant the session was bound to at each outbox enqueue. */
  const tenantAtEnqueue: string[] = [];
  // Parent-routing still opens a plain transaction (outbox only, no tenant table).
  const dataSource = Object.assign(mockDataSource, {
    transaction: jest.fn(
      (cb: (m: typeof transactionManager) => Promise<unknown>): Promise<unknown> =>
        cb(transactionManager),
    ),
  });

  // Tenant-scoped repositories (tenantManagerRepo over the session manager).
  const sensorRepository = createMockRepository<Sensor>();
  const channelRepository = createMockRepository<SensorDataChannel>();

  // Auto-provisioning of missing channels (SENSOR-HIGH-085 / B1) inserts through
  // the session manager's query builder with orIgnore(); these are the values
  // each insert chain was handed.
  const insertedChannelValues = (): unknown[] =>
    queryBuilders.flatMap((qb) => qb['values']?.mock.calls.map(([values]) => values) ?? []);

  const mockOutboxPublisher = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  const mockCalibrationService = {
    applyCalibration: jest.fn(),
    warmChannelCache: jest.fn(),
    clearCache: jest.fn(),
    getChannels: jest.fn().mockResolvedValue([]),
  };

  // The single writer for sensor.sensor_metrics — writeManaged() is on the
  // GraphQL ingest path (inside the ingest transaction).
  const mockMetricWriter = {
    writeManaged: jest.fn().mockResolvedValue(undefined),
  };

  const mockDataQualityService = {
    hasValidMetrics: jest.fn().mockReturnValue(true),
    calculateQuality: jest.fn().mockReturnValue(95),
  };

  const mockReadingMapperRegistry = {
    mapToReadings: jest.fn(),
  };

  const baseInput: IngestReadingData = {
    sensorId: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT_ID,
    readings: { temperature: 24.5, ph: 7.1 },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDataQualityService.hasValidMetrics.mockReturnValue(true);
    mockDataQualityService.calculateQuality.mockReturnValue(95);
    mockCalibrationService.applyCalibration.mockImplementation(
      async (_sensorId: string, _tenantId: string, readings: SensorReadings) => readings,
    );
    mockCalibrationService.getChannels.mockResolvedValue([]);
    mockMetricWriter.writeManaged.mockResolvedValue(undefined);
    dataSource.transaction.mockImplementation(
      (cb: (m: typeof transactionManager) => Promise<unknown>): Promise<unknown> =>
        cb(transactionManager),
    );
    boundTenants.length = 0;
    tenantAtEnqueue.length = 0;
    sensorRepository.find.mockResolvedValue([]);
    sensorRepository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });
    channelRepository.find.mockResolvedValue([]);
    transactionManager.getRepository.mockImplementation(
      (entity): Repository<ObjectLiteral> =>
        entity === Sensor ? sensorRepository : channelRepository,
    );
    queryBuilders.length = 0;
    mockOutboxPublisher.enqueue.mockImplementation(async () => {
      tenantAtEnqueue.push(session.tenant);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorIngestionService,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: OutboxPublisher, useValue: mockOutboxPublisher },
        { provide: CalibrationService, useValue: mockCalibrationService },
        { provide: DataQualityService, useValue: mockDataQualityService },
        { provide: ReadingMapperRegistry, useValue: mockReadingMapperRegistry },
        { provide: SensorMetricWriterService, useValue: mockMetricWriter },
      ],
    }).compile();

    service = module.get<SensorIngestionService>(SensorIngestionService);
  });

  describe('ingestReading() — single durable ingest', () => {
    it('enqueues the SensorReading event on the transactional manager and writes no stored row', async () => {
      await service.ingestReading(baseInput);

      // No sensor_readings row is written — the reading is an as-of projection.
      expect(transactionManager.save).not.toHaveBeenCalled();

      // Event enqueued on the outbox with the transactional manager (atomicity).
      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledTimes(1);
      const [event, managerArg] = mockOutboxPublisher.enqueue.mock.calls[0];
      expect(managerArg).toBe(transactionManager);
      expect(event).toMatchObject({
        eventType: 'SensorReading',
        tenantId: TENANT_ID,
        sensorId: baseInput.sensorId,
        readingTemperature: 24.5,
        readingPh: 7.1,
      });
    });

    it('returns a reading whose id is the as-of anchor codec (D1)', async () => {
      const result = await service.ingestReading(baseInput);

      const decoded = decodeSensorReadingId(result.id);
      expect(decoded).not.toBeNull();
      expect(decoded!.sensorId).toBe(baseInput.sensorId);
      // The anchor is the reading's own instant in the ONE canonical spelling
      // the read paths also mint, so ingesting and then querying a reading
      // yields a single federation entity rather than two.
      expect(decoded!.anchor).toBe(`${result.timestamp.toISOString().slice(0, -1)}000Z`);
    });

    it("runs the enqueue — and every other statement — bound to the reading's tenant (SENSOR-HIGH-145/148)", async () => {
      await service.ingestReading(baseInput);

      expect(tenantAtEnqueue).toEqual([TENANT_ID]);
      // Channel provisioning, the atomic write and the last_seen update each
      // committed bound to the reading's tenant, never to none.
      expect(boundTenants.length).toBeGreaterThanOrEqual(2);
      expect(new Set(boundTenants)).toEqual(new Set([TENANT_ID]));
    });

    it('propagates an enqueue failure so the ingest rejects (transaction rolls back)', async () => {
      mockOutboxPublisher.enqueue.mockRejectedValue(new Error('outbox down'));

      await expect(service.ingestReading(baseInput)).rejects.toThrow('outbox down');
    });
  });

  describe('ingestBatch() — chunked durable ingest', () => {
    it('enqueues one SensorReading event per reading on the chunk manager, no stored insert', async () => {
      const count = await service.ingestBatch([baseInput, baseInput]);

      expect(count).toBe(2);
      expect(transactionManager.insert).not.toHaveBeenCalled();
      // One enqueue per reading, each on the transactional manager.
      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledTimes(2);
      for (const call of mockOutboxPublisher.enqueue.mock.calls) {
        const [event, managerArg] = call;
        expect(managerArg).toBe(transactionManager);
        expect(event).toMatchObject({ eventType: 'SensorReading', tenantId: TENANT_ID });
      }
    });

    it('commits a mixed-tenant chunk as one transaction per tenant, each bound to it', async () => {
      const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

      const count = await service.ingestBatch([
        baseInput,
        { ...baseInput, sensorId: '44444444-4444-4444-8444-444444444444', tenantId: OTHER_TENANT },
        baseInput,
      ]);

      expect(count).toBe(3);
      // Each reading's event was enqueued under its own tenant's binding.
      const tenantsPerEnqueue = mockOutboxPublisher.enqueue.mock.calls.map(
        ([event]) => (event as { tenantId: string }).tenantId,
      );
      expect(tenantsPerEnqueue).toEqual([TENANT_ID, TENANT_ID, OTHER_TENANT]);
      expect(tenantAtEnqueue).toEqual(tenantsPerEnqueue);
      expect(new Set(boundTenants)).toEqual(new Set([TENANT_ID, OTHER_TENANT]));
    });

    it('propagates a chunk enqueue failure so the batch ingest rejects', async () => {
      mockOutboxPublisher.enqueue.mockRejectedValue(new Error('outbox down'));

      await expect(service.ingestBatch([baseInput])).rejects.toThrow('outbox down');
    });
  });

  describe('ingestParentReading() — parent routing event durability', () => {
    it('enqueues the ParentReadingRouted event on a transactional manager', async () => {
      const child: Partial<Sensor> = {
        id: '44444444-4444-4444-8444-444444444444',
        dataPath: 'data.temp',
        type: undefined,
      };
      sensorRepository.find.mockResolvedValueOnce([child as Sensor]);

      const result = await service.ingestParentReading(
        '55555555-5555-4555-8555-555555555555',
        TENANT_ID,
        { other: 1 },
      );

      expect(result.processedCount).toBe(0);
      const routedCalls = mockOutboxPublisher.enqueue.mock.calls.filter(
        ([event]) => event.eventType === 'ParentReadingRouted',
      );
      expect(routedCalls).toHaveLength(1);
      const [routedEvent, managerArg] = routedCalls[0];
      expect(managerArg).toBe(transactionManager);
      expect(routedEvent).toMatchObject({
        eventType: 'ParentReadingRouted',
        tenantId: TENANT_ID,
        parentId: '55555555-5555-4555-8555-555555555555',
        childCount: 1,
      });
    });
  });

  describe('sensor_metrics projection (SENSOR-MEDIUM-066/068)', () => {
    // A real SensorDataChannel instance so validateValue() is the production
    // method (undefined bounds → in-range → good quality), no mock behaviour.
    const buildChannel = (over: Partial<SensorDataChannel>): SensorDataChannel =>
      Object.assign(new SensorDataChannel(), over);

    it('writes a channel-keyed sensor_metrics row on the SAME transaction manager', async () => {
      const channel = buildChannel({
        id: '66666666-6666-4666-8666-666666666666',
        channelKey: 'temperature',
      });
      mockCalibrationService.getChannels.mockResolvedValue([channel]);

      await service.ingestReading({ ...baseInput, readings: { temperature: 24.5 } });

      // Metric written on the SAME manager as the outbox enqueue — atomic.
      expect(mockMetricWriter.writeManaged).toHaveBeenCalledTimes(1);
      const [metrics, managerArg] = mockMetricWriter.writeManaged.mock.calls[0];
      expect(managerArg).toBe(transactionManager);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        sensorId: baseInput.sensorId,
        channelId: channel.id,
        tenantId: TENANT_ID,
        value: 24.5,
        rawValue: 24.5,
        sourceProtocol: 'graphql',
      });
    });

    it('auto-provisions a channel when a reported parameter has none, so the value is stored not dropped (B1)', async () => {
      const channel = buildChannel({
        id: '77777777-7777-4777-8777-777777777777',
        channelKey: 'temperature',
      });
      // First resolve: no channels at all. After auto-provisioning, the sensor
      // has the temperature channel.
      mockCalibrationService.getChannels.mockResolvedValueOnce([]).mockResolvedValue([channel]);

      await service.ingestReading({ ...baseInput, readings: { temperature: 24.5 } });

      // A channel was provisioned for the reported parameter...
      expect(insertedChannelValues()).toHaveLength(1);
      expect(insertedChannelValues()[0]).toEqual([
        expect.objectContaining({
          sensorId: baseInput.sensorId,
          tenantId: TENANT_ID,
          channelKey: 'temperature',
        }),
      ]);
      // ...and the value landed in sensor_metrics instead of vanishing.
      expect(mockMetricWriter.writeManaged).toHaveBeenCalledTimes(1);
      const [metrics] = mockMetricWriter.writeManaged.mock.calls[0];
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({ channelId: channel.id, value: 24.5 });
    });

    it('provisions a multi-word parameter under its canonical snake_case key', async () => {
      // The camelCase parameter name would create `dissolvedOxygen` next to a
      // device's own `dissolved_oxygen`: two channels for one parameter, and an
      // ordering-dependent winner in the as-of projection.
      const channel = buildChannel({
        id: '77777777-7777-4777-8777-777777777777',
        channelKey: 'dissolved_oxygen',
      });
      mockCalibrationService.getChannels.mockResolvedValueOnce([]).mockResolvedValue([channel]);

      await service.ingestReading({ ...baseInput, readings: { dissolvedOxygen: 6.8 } });

      expect(insertedChannelValues()[0]).toEqual([
        expect.objectContaining({ channelKey: 'dissolved_oxygen' }),
      ]);
      const [metrics] = mockMetricWriter.writeManaged.mock.calls[0];
      expect(metrics[0]).toMatchObject({ channelId: channel.id, value: 6.8 });
    });

    it('does not provision anything when every reported parameter already has a channel', async () => {
      const channel = buildChannel({
        id: '66666666-6666-4666-8666-666666666666',
        channelKey: 'temperature',
      });
      mockCalibrationService.getChannels.mockResolvedValue([channel]);

      await service.ingestReading({ ...baseInput, readings: { temperature: 24.5 } });

      expect(insertedChannelValues()).toHaveLength(0);
      expect(mockMetricWriter.writeManaged).toHaveBeenCalledTimes(1);
    });

    it('writes one metric per mapped parameter across a batch chunk', async () => {
      const channel = buildChannel({
        id: '66666666-6666-4666-8666-666666666666',
        channelKey: 'temperature',
      });
      mockCalibrationService.getChannels.mockResolvedValue([channel]);

      await service.ingestBatch([{ ...baseInput, readings: { temperature: 24.5 } }]);

      expect(mockMetricWriter.writeManaged).toHaveBeenCalledTimes(1);
      const [metrics, managerArg] = mockMetricWriter.writeManaged.mock.calls[0];
      expect(managerArg).toBe(transactionManager);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        channelId: channel.id,
        sourceProtocol: 'graphql',
      });
    });
  });

  describe('getCircuitBreakerStates()', () => {
    it('reports only the database breaker (event delivery moved to the outbox)', () => {
      const states = service.getCircuitBreakerStates();
      expect(states).toHaveProperty('database');
      expect(states).not.toHaveProperty('eventBus');
    });
  });
});
