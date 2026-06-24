import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import { SensorDataChannel } from '../../../database/entities/sensor-data-channel.entity';
import {
  SensorReading,
  SensorReadings,
} from '../../../database/entities/sensor-reading.entity';
import { Sensor } from '../../../database/entities/sensor.entity';
import { CalibrationService } from '../calibration.service';
import { DataQualityService } from '../data-quality.service';
import { ReadingMapperRegistry } from '../reading-mapper.service';
import { SensorIngestionService, IngestReadingData } from '../sensor-ingestion.service';

/**
 * SensorIngestionService — transactional outbox durability (SENSOR-CRITICAL-001).
 *
 * The load-bearing assertion across this suite: the SensorReading /
 * ParentReadingRouted events are ENQUEUED on the transactional manager via
 * `OutboxPublisher.enqueue(event, manager)` — NOT published fire-and-forget
 * via the event bus. The save and the enqueue share one transaction, so a
 * dropped broker connection can no longer lose an alert-triggering event.
 */
describe('SensorIngestionService — outbox durability', () => {
  let service: SensorIngestionService;

  const TENANT_ID = '11111111-1111-4111-8111-111111111111';

  // A structurally-typed stand-in for the transactional EntityManager the
  // outbox enqueue must receive. Only the surface the service touches is
  // modelled; no casts needed because the transaction mock is typed against
  // exactly this shape.
  const transactionManager = {
    save: jest.fn(),
    insert: jest.fn(),
  };

  const mockReadingRepository = {
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockSensorRepository = {
    update: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
  };

  const mockChannelRepository = {
    findBy: jest.fn().mockResolvedValue([]),
  };

  // `transaction(cb)` invokes the caller's callback with the transactional
  // manager and returns its result — mirroring TypeORM's real contract. The
  // callback param is typed structurally so no unsafe type cast is required.
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
  };

  const mockDataQualityService = {
    hasValidMetrics: jest.fn().mockReturnValue(true),
    calculateQuality: jest.fn().mockReturnValue(95),
  };

  const mockReadingMapperRegistry = {
    mapToReadings: jest.fn(),
  };

  /**
   * Build a SensorReading test double. `Partial<SensorReading>` keeps the
   * return type honest without forcing every column, and avoids casts.
   */
  const buildReading = (overrides: Partial<SensorReading> = {}): SensorReading => {
    const readings: SensorReadings = { temperature: 24.5, ph: 7.1 };
    const reading: Partial<SensorReading> = {
      id: '22222222-2222-4222-8222-222222222222',
      sensorId: '33333333-3333-4333-8333-333333333333',
      tenantId: TENANT_ID,
      readings,
      timestamp: new Date('2026-06-24T00:00:00.000Z'),
      source: 'http',
      quality: 95,
      ...overrides,
    };
    return reading as SensorReading;
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
    mockDataSource.transaction.mockImplementation(
      (cb: (m: typeof transactionManager) => Promise<unknown>): Promise<unknown> =>
        cb(transactionManager),
    );
    mockOutboxPublisher.enqueue.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorIngestionService,
        { provide: getRepositoryToken(SensorReading), useValue: mockReadingRepository },
        { provide: getRepositoryToken(Sensor), useValue: mockSensorRepository },
        { provide: getRepositoryToken(SensorDataChannel), useValue: mockChannelRepository },
        // useValue is untyped — the structural mock satisfies DI without casts.
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: mockOutboxPublisher },
        { provide: CalibrationService, useValue: mockCalibrationService },
        { provide: DataQualityService, useValue: mockDataQualityService },
        { provide: ReadingMapperRegistry, useValue: mockReadingMapperRegistry },
      ],
    }).compile();

    service = module.get<SensorIngestionService>(SensorIngestionService);
  });

  describe('ingestReading() — single durable ingest', () => {
    it('saves the reading and enqueues the SensorReading event on the SAME transactional manager', async () => {
      const reading = buildReading();
      mockReadingRepository.create.mockReturnValue(reading);
      transactionManager.save.mockResolvedValue(reading);

      await service.ingestReading(baseInput);

      // Save went through the transactional manager (not the repository).
      expect(transactionManager.save).toHaveBeenCalledWith(SensorReading, reading);

      // Event was enqueued on the outbox with the SAME transactional manager —
      // this is the atomicity guarantee. No fire-and-forget eventBus publish.
      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledTimes(1);
      const [event, managerArg] = mockOutboxPublisher.enqueue.mock.calls[0];
      expect(managerArg).toBe(transactionManager);
      expect(event).toMatchObject({
        eventType: 'SensorReading',
        tenantId: TENANT_ID,
        sensorId: reading.sensorId,
        readingTemperature: 24.5,
        readingPh: 7.1,
      });
    });

    it('enqueues within the transaction (transaction wraps save + enqueue)', async () => {
      const reading = buildReading();
      mockReadingRepository.create.mockReturnValue(reading);
      transactionManager.save.mockResolvedValue(reading);

      await service.ingestReading(baseInput);

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('propagates an enqueue failure so the ingest rejects (transaction rolls back, no eventless reading)', async () => {
      const reading = buildReading();
      mockReadingRepository.create.mockReturnValue(reading);
      transactionManager.save.mockResolvedValue(reading);
      mockOutboxPublisher.enqueue.mockRejectedValue(new Error('outbox down'));

      await expect(service.ingestReading(baseInput)).rejects.toThrow('outbox down');
    });
  });

  describe('ingestBatch() — chunked durable ingest', () => {
    it('inserts each chunk and enqueues one SensorReading event per reading on the chunk manager', async () => {
      const readingA = buildReading({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      const readingB = buildReading({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      mockReadingRepository.create
        .mockReturnValueOnce(readingA)
        .mockReturnValueOnce(readingB);
      transactionManager.insert.mockResolvedValue(undefined);

      const count = await service.ingestBatch([baseInput, baseInput]);

      expect(count).toBe(2);
      expect(transactionManager.insert).toHaveBeenCalledWith(SensorReading, [readingA, readingB]);
      // One enqueue per reading, each on the transactional manager.
      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledTimes(2);
      for (const call of mockOutboxPublisher.enqueue.mock.calls) {
        const [event, managerArg] = call;
        expect(managerArg).toBe(transactionManager);
        expect(event).toMatchObject({ eventType: 'SensorReading', tenantId: TENANT_ID });
      }
    });

    it('propagates a chunk enqueue failure so the batch ingest rejects', async () => {
      const reading = buildReading();
      mockReadingRepository.create.mockReturnValue(reading);
      transactionManager.insert.mockResolvedValue(undefined);
      mockOutboxPublisher.enqueue.mockRejectedValue(new Error('outbox down'));

      await expect(service.ingestBatch([baseInput])).rejects.toThrow('outbox down');
    });
  });

  describe('ingestParentReading() — parent routing event durability', () => {
    it('enqueues the ParentReadingRouted event on a transactional manager', async () => {
      // No child sensors → service returns early WITHOUT publishing the routing
      // event, so exercise the routed path with a child that has no value.
      const child: Partial<Sensor> = {
        id: '44444444-4444-4444-8444-444444444444',
        dataPath: 'data.temp',
        type: undefined,
      };
      mockSensorRepository.find.mockResolvedValueOnce([child as Sensor]);
      // No matching value in payload → child yields null, no reading created,
      // but the routing summary event must still be enqueued durably.

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

  describe('getCircuitBreakerStates()', () => {
    it('reports only the database breaker (event delivery moved to the outbox)', () => {
      const states = service.getCircuitBreakerStates();
      expect(states).toHaveProperty('database');
      expect(states).not.toHaveProperty('eventBus');
    });
  });
});
