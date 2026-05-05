import { Test, TestingModule } from '@nestjs/testing';
import { CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { of } from 'rxjs';
import { REDIS_CLIENT } from '../../redis.provider';
import {
  MessagingRateLimitInterceptor,
  RATE_LIMIT_ACTION_KEY,
} from '../messaging-rate-limit.interceptor';
import { MessagingMetricsService } from '../../../metrics/messaging-metrics.service';
import {
  createMockRedis,
  fakeUuid,
  resetUuidCounter,
  MockRedis,
} from '../../../__tests__/test-helpers';

// Mock GqlExecutionContext
jest.mock('@nestjs/graphql', () => ({
  ...jest.requireActual('@nestjs/graphql'),
  GqlExecutionContext: {
    create: jest.fn(),
  },
}));

describe('MessagingRateLimitInterceptor', () => {
  let interceptor: MessagingRateLimitInterceptor;
  let redisClient: MockRedis;
  let reflector: { getAllAndOverride: jest.Mock };

  const userId = fakeUuid('usr');
  const tenantId = 'tenant-0001-0001-0001-000000000001';

  const mockCallHandler: CallHandler = {
    handle: jest.fn().mockReturnValue(of({ success: true })),
  };

  beforeEach(async () => {
    resetUuidCounter();

    redisClient = createMockRedis();
    reflector = {
      getAllAndOverride: jest.fn(),
    };

    const mockMetricsService = {
      incrementRateLimitHits: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingRateLimitInterceptor,
        { provide: REDIS_CLIENT, useValue: redisClient },
        { provide: Reflector, useValue: reflector },
        { provide: MessagingMetricsService, useValue: mockMetricsService },
      ],
    }).compile();

    interceptor = module.get(MessagingRateLimitInterceptor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function createMockContext(): ExecutionContext {
    const mockGqlCtx = {
      getContext: jest.fn().mockReturnValue({
        req: {
          user: { sub: userId, tenantId },
        },
      }),
    };
    (GqlExecutionContext.create as jest.Mock).mockReturnValue(mockGqlCtx);
    return {
      getType: jest.fn().mockReturnValue('graphql'),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as unknown as ExecutionContext;
  }

  // -----------------------------------------------------------------------
  // No action metadata -> pass through
  // -----------------------------------------------------------------------
  it('passes through when no rate limit action metadata is set', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = createMockContext();

    const result$ = await interceptor.intercept(ctx, mockCallHandler);
    expect(mockCallHandler.handle).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Within limit
  // -----------------------------------------------------------------------
  it('allows request within rate limit', async () => {
    reflector.getAllAndOverride.mockReturnValue('sendMessage');

    // Sorted set pipeline: [removeOld, count=5, add, expire]
    const pipelineExec = jest.fn().mockResolvedValue([
      [null, 0],     // ZREMRANGEBYSCORE
      [null, 5],     // ZCARD: 5 < 30
      [null, 1],     // ZADD
      [null, 1],     // EXPIRE
    ]);
    redisClient.multi.mockReturnValue({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: pipelineExec,
    });

    const ctx = createMockContext();
    const result$ = await interceptor.intercept(ctx, mockCallHandler);

    expect(mockCallHandler.handle).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Exceeds sendMessage rate
  // -----------------------------------------------------------------------
  it('blocks request exceeding sendMessage rate (30/min)', async () => {
    reflector.getAllAndOverride.mockReturnValue('sendMessage');

    // Count = 30, which is >= limit of 30
    const pipelineExec = jest.fn().mockResolvedValue([
      [null, 0],     // ZREMRANGEBYSCORE
      [null, 30],    // ZCARD: 30 >= 30
      [null, 1],     // ZADD
      [null, 1],     // EXPIRE
    ]);
    redisClient.multi.mockReturnValue({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: pipelineExec,
    });

    const ctx = createMockContext();

    await expect(interceptor.intercept(ctx, mockCallHandler)).rejects.toThrow(HttpException);

    try {
      await interceptor.intercept(ctx, mockCallHandler);
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(429);
    }
  });

  // -----------------------------------------------------------------------
  // Exceeds uploadMedia rate
  // -----------------------------------------------------------------------
  it('blocks request exceeding uploadMedia rate (10/min)', async () => {
    reflector.getAllAndOverride.mockReturnValue('uploadMedia');

    const pipelineExec = jest.fn().mockResolvedValue([
      [null, 0],
      [null, 10], // 10 >= limit of 10
      [null, 1],
      [null, 1],
    ]);
    redisClient.multi.mockReturnValue({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: pipelineExec,
    });

    const ctx = createMockContext();

    await expect(interceptor.intercept(ctx, mockCallHandler)).rejects.toThrow(HttpException);
  });

  // -----------------------------------------------------------------------
  // 429 response includes retryAfter
  // -----------------------------------------------------------------------
  it('returns 429 with retryAfter in response body', async () => {
    reflector.getAllAndOverride.mockReturnValue('sendMessage');

    const pipelineExec = jest.fn().mockResolvedValue([
      [null, 0],
      [null, 31],
      [null, 1],
      [null, 1],
    ]);
    redisClient.multi.mockReturnValue({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: pipelineExec,
    });

    const ctx = createMockContext();

    try {
      await interceptor.intercept(ctx, mockCallHandler);
      fail('Expected HttpException');
    } catch (e) {
      const httpError = e as HttpException;
      expect(httpError.getStatus()).toBe(429);
      const response = httpError.getResponse() as Record<string, unknown>;
      expect(response['retryAfter']).toBeDefined();
    }
  });

  // -----------------------------------------------------------------------
  // CIRCUIT-MEDIUM-005 — per-action fail-mode discriminator on Redis outage
  // -----------------------------------------------------------------------
  describe('CIRCUIT-MEDIUM-005 — per-action fail-mode on Redis outage', () => {
    /**
     * Helper that primes a Redis-down failure scenario.
     */
    const primeRedisOutage = (): void => {
      const pipelineExec = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));
      redisClient.multi.mockReturnValue({
        zremrangebyscore: jest.fn().mockReturnThis(),
        zcard: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: pipelineExec,
      });
    };

    it('fail-CLOSED action (sendMessage) blocks with HTTP 503 when Redis is down', async () => {
      reflector.getAllAndOverride.mockReturnValue('sendMessage');
      primeRedisOutage();
      const ctx = createMockContext();

      await expect(
        interceptor.intercept(ctx, mockCallHandler),
      ).rejects.toThrow();

      // Inspect the thrown HttpException — must be 503.
      try {
        await interceptor.intercept(ctx, mockCallHandler);
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpError = err as HttpException;
        expect(httpError.getStatus()).toBe(503);
      }
      expect(mockCallHandler.handle).not.toHaveBeenCalled();
    });

    it('fail-CLOSED action (uploadMedia) blocks with HTTP 503 when Redis is down', async () => {
      reflector.getAllAndOverride.mockReturnValue('uploadMedia');
      primeRedisOutage();
      const ctx = createMockContext();

      await expect(
        interceptor.intercept(ctx, mockCallHandler),
      ).rejects.toThrow();
      expect(mockCallHandler.handle).not.toHaveBeenCalled();
    });

    it('fail-CLOSED action (createChannel) blocks with HTTP 503 when Redis is down', async () => {
      reflector.getAllAndOverride.mockReturnValue('createChannel');
      primeRedisOutage();
      const ctx = createMockContext();

      await expect(
        interceptor.intercept(ctx, mockCallHandler),
      ).rejects.toThrow();
      expect(mockCallHandler.handle).not.toHaveBeenCalled();
    });

    it('fail-OPEN action (editMessage) ALLOWS request when Redis is down', async () => {
      reflector.getAllAndOverride.mockReturnValue('editMessage');
      primeRedisOutage();
      const ctx = createMockContext();

      await interceptor.intercept(ctx, mockCallHandler);
      expect(mockCallHandler.handle).toHaveBeenCalled();
    });

    it('fail-OPEN action (addReaction) ALLOWS request when Redis is down', async () => {
      reflector.getAllAndOverride.mockReturnValue('addReaction');
      primeRedisOutage();
      const ctx = createMockContext();

      await interceptor.intercept(ctx, mockCallHandler);
      expect(mockCallHandler.handle).toHaveBeenCalled();
    });
  });
});
