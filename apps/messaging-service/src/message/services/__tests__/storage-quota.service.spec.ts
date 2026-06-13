/**
 * @module StorageQuotaService Tests
 * @description Unit tests for per-tenant storage quota enforcement.
 * Validates usage calculation, quota blocking, 80% warning, and cache invalidation.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { StorageQuotaService } from '../storage-quota.service';
import { MessageAttachment } from '../../entities/message-attachment.entity';
import { REDIS_CLIENT } from '../../../shared/redis.provider';
import {
  createMockDataSource,
  createMockQueryRunner,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('StorageQuotaService', () => {
  let service: StorageQuotaService;

  const TEN_GB = 10 * 1024 * 1024 * 1024;

  const mockAttachmentRepo = {
    createQueryBuilder: jest.fn(),
  };

  const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };

  const mockNatsClient = {
    emit: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue(TEN_GB),
  };

  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ total: '5000000000' }), // 5GB
  };

  // StorageWarning is now routed through the transactional outbox
  // (OutboxPublisher.enqueue inside dataSource.transaction), NOT a direct
  // NATS emit. The publisher is mocked so its real tenantId/eventType
  // validation does not run — the spec only asserts enqueue was/was not
  // invoked. @see MSG-MEDIUM-008.
  const mockOutboxPublisher = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  // The mock DataSource.transaction invokes the callback with the
  // queryRunner's manager (local test-helper contract), giving the service
  // an active-transaction manager to hand to OutboxPublisher.enqueue.
  let mockQueryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttachmentRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);
    // jest.clearAllMocks() resets call history but NOT implementations set
    // via mockResolvedValue. The cache-hit test below overrides
    // mockRedis.get to a non-null value; without re-establishing the
    // default cache-miss (null) here, that implementation leaks into later
    // tests and corrupts both the usage and quota reads (both go through
    // redis.get). Re-pin the cache-miss default per test.
    mockRedis.get.mockResolvedValue(null);

    mockQueryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(mockQueryRunner);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageQuotaService,
        { provide: getRepositoryToken(MessageAttachment), useValue: mockAttachmentRepo },
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: 'NATS_SERVICE', useValue: mockNatsClient },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: mockOutboxPublisher },
      ],
    }).compile();

    service = module.get<StorageQuotaService>(StorageQuotaService);
  });

  it('should return storage used from database when cache misses', async () => {
    const used = await service.getStorageUsed('tenant-1');

    expect(used).toBe(5_000_000_000);
    expect(mockAttachmentRepo.createQueryBuilder).toHaveBeenCalledWith('att');
    expect(mockRedis.setex).toHaveBeenCalled();
  });

  it('should return storage used from Redis cache when available', async () => {
    mockRedis.get.mockResolvedValue('3000000000');

    const used = await service.getStorageUsed('tenant-1');

    expect(used).toBe(3_000_000_000);
    expect(mockAttachmentRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('should allow upload when quota is not exceeded', async () => {
    const available = await service.hasStorageAvailable('tenant-1', 1_000_000);

    expect(available).toBe(true);
  });

  it('should block upload when quota is exceeded', async () => {
    // 5GB used, trying to add 6GB more exceeds 10GB quota
    const sixGb = 6 * 1024 * 1024 * 1024;

    await expect(service.enforceQuota('tenant-1', sixGb)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should publish StorageWarning event when usage exceeds 80%', async () => {
    // 5GB used, adding 3.5GB = 8.5GB = 85% of 10GB -> should warn.
    // The warning is enqueued on the transactional outbox (at-least-once),
    // not emitted directly to NATS, and the enqueue runs inside an active
    // transaction opened via dataSource.transaction.
    const threeAndHalfGb = 3.5 * 1024 * 1024 * 1024;

    await service.enforceQuota('tenant-1', threeAndHalfGb);

    expect(mockDataSource.transaction).toHaveBeenCalled();
    expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'StorageWarning',
        tenantId: 'tenant-1',
        usagePercentage: expect.any(Number),
      }),
      mockQueryRunner.manager,
    );
  });

  it('should not warn when usage is below 80%', async () => {
    // 5GB used, adding 1GB = 6GB = 60% of 10GB -> no warning, so nothing
    // is enqueued and no transaction is opened for the warning path.
    const oneGb = 1 * 1024 * 1024 * 1024;

    await service.enforceQuota('tenant-1', oneGb);

    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
    expect(mockDataSource.transaction).not.toHaveBeenCalled();
  });

  it('should invalidate cache', async () => {
    await service.invalidateCache('tenant-1');

    expect(mockRedis.del).toHaveBeenCalledWith('msg:tenant:tenant-1:storage_used');
  });

  it('should return correct storage stats', async () => {
    const stats = await service.getStorageStats('tenant-1');

    expect(stats.used).toBe(5_000_000_000);
    expect(stats.quota).toBe(TEN_GB);
    expect(stats.percentage).toBeCloseTo(50, -1);
    expect(stats.nearLimit).toBe(false);
  });
});
