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
  createMockQueryBuilder,
  createMockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('StorageQuotaService', () => {
  let service: StorageQuotaService;
  let queryRunner: ReturnType<typeof createMockQueryRunner>;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let mockOutboxPublisher: { enqueue: jest.Mock };

  const TEN_GB = 10 * 1024 * 1024 * 1024;
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const mockQueryBuilder = createMockQueryBuilder<MessageAttachment>();
    mockQueryBuilder.getRawOne.mockResolvedValue({ total: '5000000000' }); // 5GB
    queryRunner.manager.createQueryBuilder.mockReturnValue(mockQueryBuilder);

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
    const used = await service.getStorageUsed(tenantId);

    expect(used).toBe(5_000_000_000);
    expect(queryRunner.manager.createQueryBuilder).toHaveBeenCalledWith(MessageAttachment, 'att');
    expect(mockRedis.setex).toHaveBeenCalled();
  });

  it('should return storage used from Redis cache when available', async () => {
    mockRedis.get.mockResolvedValue('3000000000');

    const used = await service.getStorageUsed(tenantId);

    expect(used).toBe(3_000_000_000);
    expect(queryRunner.manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('should allow upload when quota is not exceeded', async () => {
    const available = await service.hasStorageAvailable(tenantId, 1_000_000);

    expect(available).toBe(true);
  });

  it('should block upload when quota is exceeded', async () => {
    // 5GB used, trying to add 6GB more exceeds 10GB quota
    const sixGb = 6 * 1024 * 1024 * 1024;

    await expect(service.enforceQuota(tenantId, sixGb)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should publish StorageWarning event when usage exceeds 80%', async () => {
    // 5GB used, adding 3.5GB = 8.5GB = 85% of 10GB -> should warn
    const threeAndHalfGb = 3.5 * 1024 * 1024 * 1024;

    await service.enforceQuota(tenantId, threeAndHalfGb);

    expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        eventType: 'StorageWarning',
        usagePercentage: expect.any(Number),
      }),
      queryRunner.manager,
    );
  });

  it('should not warn when usage is below 80%', async () => {
    // 5GB used, adding 1GB = 6GB = 60% of 10GB -> no warning
    const oneGb = 1 * 1024 * 1024 * 1024;

    await service.enforceQuota(tenantId, oneGb);

    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('should invalidate cache', async () => {
    await service.invalidateCache(tenantId);

    expect(mockRedis.del).toHaveBeenCalledWith(`msg:tenant:${tenantId}:storage_used`);
  });

  it('should return correct storage stats', async () => {
    const stats = await service.getStorageStats(tenantId);

    expect(stats.used).toBe(5_000_000_000);
    expect(stats.quota).toBe(TEN_GB);
    expect(stats.percentage).toBeCloseTo(50, -1);
    expect(stats.nearLimit).toBe(false);
  });
});
