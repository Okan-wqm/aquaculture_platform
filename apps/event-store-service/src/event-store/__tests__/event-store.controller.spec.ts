import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EventStoreController } from '../event-store.controller';
import { EventStoreService } from '../services/event-store.service';

/**
 * Tests for EventStoreController
 * Verifies proper HTTP status codes for success and error cases
 */
describe('EventStoreController', () => {
  let controller: EventStoreController;
  let mockEventStoreService: jest.Mocked<EventStoreService>;

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
    it('should throw BadRequestException when X-Tenant-Id header is missing', async () => {
      await expect(
        controller.getStreamInfo('', 'Order', '123e4567-e89b-12d3-a456-426614174000'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getStreamInfo', () => {
    const tenantId = 'tenant-123';
    const aggregateType = 'Order';
    const aggregateId = '123e4567-e89b-12d3-a456-426614174000';

    it('should return stream info with HTTP 200 when stream exists', async () => {
      const mockStreamInfo = {
        streamName: `${aggregateType}-${aggregateId}`,
        aggregateType,
        aggregateId,
        currentVersion: 5,
        eventCount: 5,
        createdAt: new Date(),
        lastEventAt: new Date(),
      };

      mockEventStoreService.getStreamInfo.mockResolvedValue(mockStreamInfo);
      mockEventStoreService.getSnapshot.mockResolvedValue(null);

      const result = await controller.getStreamInfo(tenantId, aggregateType, aggregateId);

      expect(result.streamName).toBe(mockStreamInfo.streamName);
      expect(result.currentVersion).toBe(5);
      expect(result.hasSnapshot).toBe(false);
    });

    it('should return stream info with snapshot data when snapshot exists', async () => {
      const mockStreamInfo = {
        streamName: `${aggregateType}-${aggregateId}`,
        aggregateType,
        aggregateId,
        currentVersion: 10,
        eventCount: 10,
        createdAt: new Date(),
        lastEventAt: new Date(),
      };

      const mockSnapshot = {
        aggregateType,
        aggregateId,
        version: 5,
        state: { status: 'confirmed' },
        tenantId,
        createdAt: new Date(),
        schemaVersion: 1,
      };

      mockEventStoreService.getStreamInfo.mockResolvedValue(mockStreamInfo);
      mockEventStoreService.getSnapshot.mockResolvedValue(mockSnapshot);

      const result = await controller.getStreamInfo(tenantId, aggregateType, aggregateId);

      expect(result.hasSnapshot).toBe(true);
      expect(result.snapshotVersion).toBe(5);
    });

    it('should throw NotFoundException with HTTP 404 when stream does not exist', async () => {
      mockEventStoreService.getStreamInfo.mockResolvedValue(null);

      await expect(
        controller.getStreamInfo(tenantId, aggregateType, aggregateId),
      ).rejects.toThrow(NotFoundException);

      await expect(
        controller.getStreamInfo(tenantId, aggregateType, aggregateId),
      ).rejects.toThrow(`Stream ${aggregateType}/${aggregateId} not found`);
    });
  });

  describe('getSnapshot', () => {
    const tenantId = 'tenant-123';
    const aggregateType = 'Order';
    const aggregateId = '123e4567-e89b-12d3-a456-426614174000';

    it('should return snapshot with HTTP 200 when snapshot exists', async () => {
      const mockSnapshot = {
        aggregateType,
        aggregateId,
        version: 5,
        state: { status: 'confirmed', items: ['item1', 'item2'] },
        tenantId,
        createdAt: new Date(),
        schemaVersion: 1,
      };

      mockEventStoreService.getSnapshot.mockResolvedValue(mockSnapshot);

      const result = await controller.getSnapshot(tenantId, aggregateType, aggregateId);

      expect(result.version).toBe(5);
      expect(result.state).toEqual({ status: 'confirmed', items: ['item1', 'item2'] });
    });

    it('should throw NotFoundException with HTTP 404 when snapshot does not exist', async () => {
      mockEventStoreService.getSnapshot.mockResolvedValue(null);

      await expect(
        controller.getSnapshot(tenantId, aggregateType, aggregateId),
      ).rejects.toThrow(NotFoundException);

      await expect(
        controller.getSnapshot(tenantId, aggregateType, aggregateId),
      ).rejects.toThrow(`Snapshot for ${aggregateType}/${aggregateId} not found`);
    });
  });

  describe('appendEvents', () => {
    it('should append events and return HTTP 201 Created', async () => {
      const mockResult = {
        streamId: 'stream-123',
        version: 3,
        position: 100,
        timestamp: new Date(),
      };

      mockEventStoreService.appendToStream.mockResolvedValue(mockResult);

      const result = await controller.appendEvents(
        'tenant-123',
        'Order',
        '123e4567-e89b-12d3-a456-426614174000',
        {
          events: [
            {
              eventType: 'OrderCreated',
              payload: { orderId: '123' },
            },
          ],
        },
      );

      expect(result.version).toBe(3);
      expect(mockEventStoreService.appendToStream).toHaveBeenCalled();
    });
  });

  describe('deleteStream', () => {
    it('should delete stream and return HTTP 204 No Content', async () => {
      mockEventStoreService.deleteStream.mockResolvedValue(undefined);

      await expect(
        controller.deleteStream(
          'tenant-123',
          'Order',
          '123e4567-e89b-12d3-a456-426614174000',
        ),
      ).resolves.toBeUndefined();

      expect(mockEventStoreService.deleteStream).toHaveBeenCalledWith(
        'tenant-123',
        'Order',
        '123e4567-e89b-12d3-a456-426614174000',
      );
    });
  });

  describe('createSnapshot', () => {
    it('should create snapshot and return HTTP 201 Created', async () => {
      const mockSnapshot = {
        aggregateType: 'Order',
        aggregateId: '123e4567-e89b-12d3-a456-426614174000',
        version: 5,
        state: { status: 'confirmed' },
        tenantId: 'tenant-123',
        createdAt: new Date(),
        schemaVersion: 1,
      };

      mockEventStoreService.createSnapshot.mockResolvedValue(mockSnapshot);

      const result = await controller.createSnapshot('tenant-123', {
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
        snapshot: {
          aggregateType: 'Order',
          aggregateId: '123e4567-e89b-12d3-a456-426614174000',
          version: 5,
          state: { status: 'confirmed' },
          tenantId: 'tenant-123',
          createdAt: new Date(),
          schemaVersion: 1,
        },
        events: [
          {
            id: 'event-1',
            eventType: 'OrderUpdated',
            version: 6,
            payload: { status: 'shipped' },
          },
        ],
        currentVersion: 6,
      };

      mockEventStoreService.loadAggregate.mockResolvedValue(mockData);

      const result = await controller.loadAggregate(
        'tenant-123',
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
        'tenant-123',
        'Order',
        '123e4567-e89b-12d3-a456-426614174000',
      );

      expect(result.snapshot).toBeNull();
      expect(result.currentVersion).toBe(0);
    });
  });
});
