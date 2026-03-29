import { Test, TestingModule } from '@nestjs/testing';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { PresenceService } from '../presence.service';
import {
  createMockRedis,
  fakeUuid,
  resetUuidCounter,
  MockRedis,
} from '../../__tests__/test-helpers';

describe('PresenceService', () => {
  let service: PresenceService;
  let redisClient: MockRedis;

  const tenantId = 'tenant-0001-0001-0001-000000000001';
  const userId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    redisClient = createMockRedis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PresenceService,
        { provide: REDIS_CLIENT, useValue: redisClient },
      ],
    }).compile();

    service = module.get(PresenceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Set online
  // -----------------------------------------------------------------------
  it('sets user online in Redis via pipeline', async () => {
    const pipelineExec = jest.fn().mockResolvedValue([]);
    const pipelineMethods = {
      set: jest.fn().mockReturnThis(),
      exec: pipelineExec,
    };
    redisClient.pipeline.mockReturnValue(pipelineMethods);

    await service.setOnline(tenantId, userId);

    expect(redisClient.pipeline).toHaveBeenCalled();
    expect(pipelineMethods.set).toHaveBeenCalled();

    // First set call should be the presence key
    const firstSetArgs = pipelineMethods.set.mock.calls[0];
    expect(firstSetArgs[0]).toContain(tenantId);
    expect(firstSetArgs[0]).toContain(userId);
    expect(firstSetArgs[1]).toBe('online');
  });

  // -----------------------------------------------------------------------
  // Set offline
  // -----------------------------------------------------------------------
  it('sets user offline (deletes presence key via pipeline)', async () => {
    const pipelineExec = jest.fn().mockResolvedValue([]);
    const pipelineMethods = {
      del: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      exec: pipelineExec,
    };
    redisClient.pipeline.mockReturnValue(pipelineMethods);

    await service.setOffline(tenantId, userId);

    expect(pipelineMethods.del).toHaveBeenCalled();
    const delKey = pipelineMethods.del.mock.calls[0][0];
    expect(delKey).toContain(userId);
  });

  // -----------------------------------------------------------------------
  // Refresh TTL
  // -----------------------------------------------------------------------
  it('refreshes presence TTL', async () => {
    await service.refreshPresence(tenantId, userId);

    expect(redisClient.expire).toHaveBeenCalled();
    const expireArgs = redisClient.expire.mock.calls[0];
    expect(expireArgs[0]).toContain(userId);
    expect(expireArgs[1]).toBe(300); // 5 minutes TTL
  });

  // -----------------------------------------------------------------------
  // Check online
  // -----------------------------------------------------------------------
  it('returns true for online user', async () => {
    redisClient.exists.mockResolvedValue(1);

    const result = await service.isOnline(tenantId, userId);

    expect(result).toBe(true);
  });

  it('returns false for offline user', async () => {
    redisClient.exists.mockResolvedValue(0);

    const result = await service.isOnline(tenantId, userId);

    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Redis failure -- graceful degradation
  // -----------------------------------------------------------------------
  it('returns false when Redis fails (graceful degradation)', async () => {
    redisClient.exists.mockRejectedValue(new Error('Redis timeout'));

    const result = await service.isOnline(tenantId, userId);

    expect(result).toBe(false);
  });
});
