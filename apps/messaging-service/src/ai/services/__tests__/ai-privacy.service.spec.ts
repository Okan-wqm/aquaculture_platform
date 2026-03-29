import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../../../shared/redis.provider';
import { AiPrivacyService } from '../ai-privacy.service';
import {
  createMockRedis,
  fakeUuid,
  resetUuidCounter,
  MockRedis,
  TENANT_A,
} from '../../../__tests__/test-helpers';

describe('AiPrivacyService', () => {
  let service: AiPrivacyService;
  let redisClient: MockRedis;
  let mockDataSource: { query: jest.Mock };

  const userId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    redisClient = createMockRedis();
    mockDataSource = { query: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiPrivacyService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: REDIS_CLIENT, useValue: redisClient },
      ],
    }).compile();

    service = module.get(AiPrivacyService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // canAnalyzeMessage — dual consent
  // -----------------------------------------------------------------------
  it('returns true when both tenant AI enabled and user consented', async () => {
    // Tenant enabled in Redis cache
    redisClient.get.mockResolvedValueOnce('true');
    // User consented in Redis cache
    redisClient.get.mockResolvedValueOnce('true');

    const result = await service.canAnalyzeMessage(TENANT_A, userId);

    expect(result).toBe(true);
  });

  it('returns false when tenant AI is disabled', async () => {
    redisClient.get.mockResolvedValueOnce('false');
    // User consent is never checked because tenant is disabled

    const result = await service.canAnalyzeMessage(TENANT_A, userId);

    expect(result).toBe(false);
  });

  it('returns false when user has not consented', async () => {
    // Tenant enabled
    redisClient.get.mockResolvedValueOnce('true');
    // User NOT consented
    redisClient.get.mockResolvedValueOnce('false');

    const result = await service.canAnalyzeMessage(TENANT_A, userId);

    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // updateTenantAiSetting — Redis + DB
  // -----------------------------------------------------------------------
  it('stores tenant AI setting in DB and invalidates Redis cache', async () => {
    mockDataSource.query.mockResolvedValueOnce([]);

    await service.updateTenantAiSetting(TENANT_A, true);

    expect(mockDataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_settings'),
      expect.arrayContaining([TENANT_A, true]),
    );
    expect(redisClient.del).toHaveBeenCalledWith(
      expect.stringContaining(TENANT_A),
    );
  });

  // -----------------------------------------------------------------------
  // updateUserAiConsent — Redis + DB
  // -----------------------------------------------------------------------
  it('stores user AI consent in DB and invalidates Redis cache', async () => {
    mockDataSource.query.mockResolvedValueOnce([]);

    await service.updateUserAiConsent(TENANT_A, userId, true);

    expect(mockDataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('user_preferences'),
      expect.arrayContaining([userId, TENANT_A, true]),
    );
    expect(redisClient.del).toHaveBeenCalledWith(
      expect.stringContaining(userId),
    );
  });

  // -----------------------------------------------------------------------
  // Redis failure — falls back to DB
  // -----------------------------------------------------------------------
  it('falls back to DB when Redis GET fails for tenant setting', async () => {
    // Redis fails
    redisClient.get.mockRejectedValueOnce(new Error('Redis timeout'));
    // DB returns tenant enabled
    mockDataSource.query.mockResolvedValueOnce([{ aiAnalysisEnabled: true }]);
    // User consent from Redis succeeds
    redisClient.get.mockResolvedValueOnce('true');

    const result = await service.canAnalyzeMessage(TENANT_A, userId);

    expect(result).toBe(true);
    // Verify DB was queried as fallback
    expect(mockDataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_settings'),
      expect.arrayContaining([TENANT_A]),
    );
  });

  it('falls back to DB when Redis GET fails for user consent', async () => {
    // Tenant setting from Redis
    redisClient.get.mockResolvedValueOnce('true');
    // User consent Redis fails
    redisClient.get.mockRejectedValueOnce(new Error('Redis timeout'));
    // DB returns user consented
    mockDataSource.query.mockResolvedValueOnce([{ aiAnalysisConsent: true }]);

    const result = await service.canAnalyzeMessage(TENANT_A, userId);

    expect(result).toBe(true);
  });
});
