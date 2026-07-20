import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { decodeSensorReadingId } from '@aquaculture/backend-common/sensor';
import { OutboxPublisher } from '@platform/outbox';

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

  // The transactional EntityManager the outbox enqueue + metric write receive.
  // The service no longer calls save/insert on it — it is only an identity the
  // atomicity assertions match against.
  const transactionManager = { save: jest.fn(), insert: jest.fn() };

  const mockSensorRepository = {
    update: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
  };

  const mockChannelRepository = {
    findBy: jest.fn().mockResolvedValue([]),
  };

  // `transaction(cb)` invokes the caller's callback with the transactional
  // manager and returns its result — mirroring TypeORM's real contract.
  const mockDataSource = {
    transaction: jest.fn(
      (cb: (m: typeof transactionManager) => Promise<unknown>): Promise<unknown> =>
        cb(transactionManager),
    ),
  };

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
      async (_sensorId: string, readings: SensorReadings) => readings,
    );
    mockCalibrationService.getChannels.mockResolvedValue([]);
    mockMetricWriter.writeManaged.mockResolvedValue(undefined);
    mockDataSource.transaction.mockImplementation(
      (cb: (m: typeof transactionManager) => Promise<unknown>): Promise<unknown> =>
        cb(transactionManager),
    );
    mockOutboxPublisher.enqueue.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorIngestionService,
        { provide: getRepositoryToken(Sensor), useValue: mockSensorRepository },
        { provide: getRepositoryToken(SensorDataChannel), useValue: mockChannelRepository },
        { provide: getDataSourceToken(), useValue: mockDataSource },
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
      // The anchor matches the reading's own timestamp — round-trippable.
      expect(decoded!.timeText).toBe(result.timestamp.toISOString());
    });

    it('enqueues within the transaction', async () => {
      await service.ingestReading(baseInput);

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
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
      mockSensorRepository.find.mockResolvedValueOnce([child as Sensor]);

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

    it('skips metrics for parameters with no channel but still enqueues the event', async () => {
      // No channels → temperature resolves to no channel → no metric row.
      mockCalibrationService.getChannels.mockResolvedValue([]);

      await service.ingestReading({ ...baseInput, readings: { temperature: 24.5 } });

      expect(mockMetricWriter.writeManaged).not.toHaveBeenCalled();
      // The reading event is still enqueued — the reading is ingested, just with
      // no channel-keyed metric row for the unmapped parameter.
      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledTimes(1);
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
