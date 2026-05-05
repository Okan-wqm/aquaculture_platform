import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { EventStoreController } from '../event-store.controller';
import { EventStoreService } from '../services/event-store.service';
import { EventStream } from '../entities/event-stream.entity';
import { Snapshot } from '../entities/snapshot.entity';
import { PersistedEvent } from '../interfaces/event-store.interfaces';

/**
 * Mock factories for the event-store controller's collaborator return shapes.
 *
 * These exist because controller-spec mocks were originally minimal POJOs
 * and drifted out of sync with the EventStream / Snapshot entity contracts
 * (PR-27 of the PROC-MEDIUM-007 ratchet). Service-method return types are
 * the source of truth — factories cast to the right shape and let each
 * spec spread overrides, keeping mocks aligned without per-test
 * boilerplate or `as any`.
 */
function makeStream(overrides: Partial<EventStream> = {}): EventStream {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    streamName: 'Order-123e4567-e89b-12d3-a456-426614174000',
    aggregateType: 'Order',
    aggregateId: '123e4567-e89b-12d3-a456-426614174000',
    currentVersion: 0,
    eventCount: 0,
    tenantId: '123e4567-e89b-42d3-a456-426614174000',
    isDeleted: false,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    lastEventAt: undefined,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: '00000000-0000-0000-0000-000000000002',
    aggregateType: 'Order',
    aggregateId: '123e4567-e89b-12d3-a456-426614174000',
    version: 5,
    state: { status: 'confirmed' },
    tenantId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    schemaVersion: 1,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PersistedEvent> = {}): PersistedEvent {
  return {
    id: '00000000-0000-0000-0000-000000000010',
    streamName: 'Order-123e4567-e89b-12d3-a456-426614174000',
    globalPosition: 1,
    streamPosition: 1,
    aggregateType: 'Order',
    aggregateId: '123e4567-e89b-12d3-a456-426614174000',
    version: 1,
    tenantId: '123e4567-e89b-42d3-a456-426614174000',
    eventType: 'OrderCreated',
    payload: {},
    occurredAt: new Date('2026-04-01T00:00:00Z'),
    storedAt: new Date('2026-04-01T00:00:00Z'),
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Tests for EventStoreController
 * Verifies proper HTTP status codes for success and error cases
 */
describe('EventStoreController', () => {
  let controller: EventStoreController;
  let mockEventStoreService: jest.Mocked<EventStoreService>;

  const validTenantId = '123e4567-e89b-42d3-a456-426614174000';

  beforeEach(async () => {
    mockEventStoreService = {
      appendToStream: jest.fn(),
      readStream: jest.fn(),
      getStreamInfo: jest.fn(),
      getSnapshot: jest.fn(),
      checkConcurrency: jest.fn(),
      deleteStream: jest.fn(),
      readAllEvents: jest.fn(),
      searchEvents: jest.fn(),
      getStatistics: jest.fn(),
      createSnapshot: jest.fn(),
      loadAggregate: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventStoreController],
      providers: [
        {
          provide: EventStoreService,
          useValue: mockEventStoreService,
        },
      ],
    }).compile();

    controller = module.get<EventStoreController>(EventStoreController);
  });

  describe('Tenant ID Validation', () => {
    it('should throw UnauthorizedException when X-Tenant-Id header is missing', async () => {
      await expect(
        controller.getStreamInfo('', 'Order', '123e4567-e89b-12d3-a456-426614174000'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when X-Tenant-Id is not a valid UUID', async () => {
      await expect(
        controller.getStreamInfo('not-a-uuid', 'Order', '123e4567-e89b-12d3-a456-426614174000'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('Aggregate Type Validation', () => {
    it('should throw BadRequestException when aggregateType contains path-traversal characters', async () => {
      await expect(
        controller.getStreamInfo(validTenantId, '../../../etc', '123e4567-e89b-12d3-a456-426614174000'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when aggregateType contains a hyphen (stream name collision vector)', async () => {
      await expect(
        controller.getStreamInfo(validTenantId, 'Batch-abc', '123e4567-e89b-12d3-a456-426614174000'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept a valid alphanumeric aggregateType', async () => {
      mockEventStoreService.getStreamInfo.mockResolvedValue(null);
      await expect(
        controller.getStreamInfo(validTenantId, 'Order', '123e4567-e89b-12d3-a456-426614174000'),
      ).rejects.toThrow(NotFoundException); // Passes validation, fails at not-found
    });
  });

  describe('getStreamInfo', () => {
    const aggregateType = 'Order';
    const aggregateId = '123e4567-e89b-12d3-a456-426614174000';

    it('should return stream info with HTTP 200 when stream exists', async () => {
      const mockStreamInfo = makeStream({
        streamName: `${aggregateType}-${aggregateId}`,
        aggregateType,
        aggregateId,
        currentVersion: 5,
        eventCount: 5,
        lastEventAt: new Date(),
      });

      mockEventStoreService.getStreamInfo.mockResolvedValue(mockStreamInfo);
      mockEventStoreService.getSnapshot.mockResolvedValue(null);

      const result = await controller.getStreamInfo(validTenantId, aggregateType, aggregateId);

      expect(result.streamName).toBe(mockStreamInfo.streamName);
      expect(result.currentVersion).toBe(5);
      expect(result.hasSnapshot).toBe(false);
    });

    it('should return stream info with snapshot data when snapshot exists', async () => {
      const mockStreamInfo = makeStream({
        streamName: `${aggregateType}-${aggregateId}`,
        aggregateType,
        aggregateId,
        currentVersion: 10,
        eventCount: 10,
        lastEventAt: new Date(),
      });

      const mockSnapshot = makeSnapshot({
        aggregateType,
        aggregateId,
        version: 5,
        state: { status: 'confirmed' },
        tenantId: validTenantId,
      });

      mockEventStoreService.getStreamInfo.mockResolvedValue(mockStreamInfo);
      mockEventStoreService.getSnapshot.mockResolvedValue(mockSnapshot);

      const result = await controller.getStreamInfo(validTenantId, aggregateType, aggregateId);

      expect(result.hasSnapshot).toBe(true);
      expect(result.snapshotVersion).toBe(5);
    });

    it('should throw NotFoundException with HTTP 404 when stream does not exist', async () => {
      mockEventStoreService.getStreamInfo.mockResolvedValue(null);

      await expect(
        controller.getStreamInfo(validTenantId, aggregateType, aggregateId),
      ).rejects.toThrow(NotFoundException);

      await expect(
        controller.getStreamInfo(validTenantId, aggregateType, aggregateId),
      ).rejects.toThrow(`Stream ${aggregateType}/${aggregateId} not found`);
    });
  });

  describe('getSnapshot', () => {
    const aggregateType = 'Order';
    const aggregateId = '123e4567-e89b-12d3-a456-426614174000';

    it('should return snapshot with HTTP 200 when snapshot exists', async () => {
      const mockSnapshot = {
        aggregateType,
        aggregateId,
        version: 5,
        state: { status: 'confirmed', items: ['item1', 'item2'] },
        tenantId: validTenantId,
        createdAt: new Date(),
        schemaVersion: 1,
      };

      mockEventStoreService.getSnapshot.mockResolvedValue(mockSnapshot);

      const result = await controller.getSnapshot(validTenantId, aggregateType, aggregateId);

      expect(result.version).toBe(5);
      expect(result.state).toEqual({ status: 'confirmed', items: ['item1', 'item2'] });
    });

    it('should throw NotFoundException with HTTP 404 when snapshot does not exist', async () => {
      mockEventStoreService.getSnapshot.mockResolvedValue(null);

      await expect(
        controller.getSnapshot(validTenantId, aggregateType, aggregateId),
      ).rejects.toThrow(NotFoundException);

      await expect(
        controller.getSnapshot(validTenantId, aggregateType, aggregateId),
      ).rejects.toThrow(`Snapshot for ${aggregateType}/${aggregateId} not found`);
    });
  });

  describe('appendEvents', () => {
    it('should append events and return HTTP 201 Created', async () => {
      const mockResult = {
        success: true,
        streamName: 'Order-123e4567-e89b-12d3-a456-426614174000',
        newVersion: 3,
        eventIds: ['event-1'],
        globalPositions: [100],
      };

      mockEventStoreService.appendToStream.mockResolvedValue(mockResult);

      const result = await controller.appendEvents(
        validTenantId,
        'Order',
        '123e4567-e89b-12d3-a456-426614174000',
        {
          aggregateType: 'Order',
          aggregateId: '123e4567-e89b-12d3-a456-426614174000',
          expectedVersion: -1,
          events: [
            {
              eventType: 'OrderCreated',
              payload: { orderId: '123' },
            },
          ],
        },
      );

      expect(result.newVersion).toBe(3);
      expect(result.success).toBe(true);
      expect(result.streamName).toBe('Order-123e4567-e89b-12d3-a456-426614174000');
      expect(mockEventStoreService.appendToStream).toHaveBeenCalled();
    });
  });

  describe('deleteStream', () => {
    it('should delete stream and return HTTP 204 No Content', async () => {
      mockEventStoreService.deleteStream.mockResolvedValue(undefined);

      await expect(
        controller.deleteStream(
          validTenantId,
          'Order',
          '123e4567-e89b-12d3-a456-426614174000',
        ),
      ).resolves.toBeUndefined();

      expect(mockEventStoreService.deleteStream).toHaveBeenCalledWith(
        validTenantId,
        'Order',
        '123e4567-e89b-12d3-a456-426614174000',
      );
    });
  });

  describe('createSnapshot', () => {
    it('should create snapshot and return HTTP 201 Created', async () => {
      const mockSnapshot = makeSnapshot({
        aggregateType: 'Order',
        aggregateId: '123e4567-e89b-12d3-a456-426614174000',
        version: 5,
        state: { status: 'confirmed' },
        tenantId: validTenantId,
      });

      mockEventStoreService.createSnapshot.mockResolvedValue(mockSnapshot);

      const result = await controller.createSnapshot(validTenantId, {
        aggregateType: 'Order',
        aggregateId: '123e4567-e89b-12d3-a456-426614174000',
        version: 5,
        state: { status: 'confirmed' },
        schemaVersion: 1,
      });

      expect(result.version).toBe(5);
    });
  });

  describe('loadAggregate', () => {
    it('should load aggregate with snapshot and events', async () => {
      const mockData = {
        // loadAggregate returns SnapshotData (interface), not the entity —
        // makeSnapshot()'s shape is a superset (has id/etc.) which structurally
        // satisfies SnapshotData via excess-property check on object literal.
        snapshot: makeSnapshot({
          aggregateType: 'Order',
          aggregateId: '123e4567-e89b-12d3-a456-426614174000',
          version: 5,
          state: { status: 'confirmed' },
          tenantId: validTenantId,
        }),
        events: [
          makeEvent({
            id: 'event-1',
            eventType: 'OrderUpdated',
            version: 6,
            payload: { status: 'shipped' },
          }),
        ],
        currentVersion: 6,
      };

      mockEventStoreService.loadAggregate.mockResolvedValue(mockData);

      const result = await controller.loadAggregate(
        validTenantId,
        'Order',
        '123e4567-e89b-12d3-a456-426614174000',
      );

      expect(result.snapshot).not.toBeNull();
      expect(result.events).toHaveLength(1);
      expect(result.currentVersion).toBe(6);
    });

    it('should return null snapshot when no snapshot exists', async () => {
      const mockData = {
        snapshot: null,
        events: [],
        currentVersion: 0,
      };

      mockEventStoreService.loadAggregate.mockResolvedValue(mockData);

      const result = await controller.loadAggregate(
        validTenantId,
        'Order',
        '123e4567-e89b-12d3-a456-426614174000',
      );

      expect(result.snapshot).toBeNull();
      expect(result.currentVersion).toBe(0);
    });
  });
});
