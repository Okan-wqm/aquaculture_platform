import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { SessionInfo } from '../../interfaces';
import { SessionManagerService } from '../session-manager.service';

/**
 * PERF-MEDIUM-002 — Redis-branch pipelining.
 *
 * These tests lock the O(1)-round-trip contract for the Redis branch of
 * SessionManagerService:
 *  - getUserSessions must issue ONE mget (not N gets).
 *  - revokeAllSessions / enforceSessionLimit must use ONE pipeline exec
 *    (not N serial revokeSession round-trips).
 *  - a partial pipeline failure must be counted as not-revoked (no over-report).
 *
 * The Redis client is injected through the 'REDIS_CLIENT' DI token as a typed
 * jest mock, matching the production provider wiring; no unsafe casts are used.
 */

/**
 * Minimal pipeline (ChainableCommander) surface used by revokeSessionsBatch.
 * del/srem are chainable (return the pipeline), exec resolves the tuple array.
 */
interface MockPipeline {
  del: jest.Mock<MockPipeline, [string]>;
  srem: jest.Mock<MockPipeline, [string, string]>;
  exec: jest.Mock<Promise<Array<[Error | null, unknown]> | null>, []>;
}

/**
 * Subset of the ioredis client surface SessionManagerService actually calls.
 * Declaring it explicitly (rather than casting a partial to Redis) keeps the
 * mock type-safe without casts.
 */
interface MockRedis {
  smembers: jest.Mock<Promise<string[]>, [string]>;
  mget: jest.Mock<Promise<Array<string | null>>, string[]>;
  get: jest.Mock<Promise<string | null>, [string]>;
  setex: jest.Mock<Promise<string>, [string, number, string]>;
  sadd: jest.Mock<Promise<number>, [string, string]>;
  expire: jest.Mock<Promise<number>, [string, number]>;
  ttl: jest.Mock<Promise<number>, [string]>;
  del: jest.Mock<Promise<number>, [string]>;
  srem: jest.Mock<Promise<number>, [string, string]>;
  pipeline: jest.Mock<MockPipeline, []>;
}

function createMockPipeline(
  execResult: Array<[Error | null, unknown]> | null,
): MockPipeline {
  const pipeline: MockPipeline = {
    del: jest.fn<MockPipeline, [string]>(),
    srem: jest.fn<MockPipeline, [string, string]>(),
    exec: jest.fn<Promise<Array<[Error | null, unknown]> | null>, []>().mockResolvedValue(execResult),
  };
  // del/srem are chainable — each returns the same pipeline instance.
  pipeline.del.mockReturnValue(pipeline);
  pipeline.srem.mockReturnValue(pipeline);
  return pipeline;
}

function createMockRedis(): MockRedis {
  return {
    smembers: jest.fn<Promise<string[]>, [string]>().mockResolvedValue([]),
    mget: jest.fn<Promise<Array<string | null>>, string[]>().mockResolvedValue([]),
    get: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
    setex: jest.fn<Promise<string>, [string, number, string]>().mockResolvedValue('OK'),
    sadd: jest.fn<Promise<number>, [string, string]>().mockResolvedValue(1),
    expire: jest.fn<Promise<number>, [string, number]>().mockResolvedValue(1),
    ttl: jest.fn<Promise<number>, [string]>().mockResolvedValue(-1),
    del: jest.fn<Promise<number>, [string]>().mockResolvedValue(1),
    srem: jest.fn<Promise<number>, [string, string]>().mockResolvedValue(1),
    pipeline: jest.fn<MockPipeline, []>(),
  };
}

/**
 * Build a stored-session JSON string as createSession would persist it.
 */
function activeSessionJson(
  sessionId: string,
  userId: string,
  lastActivityAt: number,
  tenantId?: string,
): string {
  return JSON.stringify({
    sessionId,
    userId,
    createdAt: lastActivityAt - 1000,
    lastActivityAt,
    expiresAt: lastActivityAt + 60_000,
    metadata: tenantId ? { tenantId } : {},
    isActive: true,
  });
}

describe('SessionManagerService (Redis branch — PERF-MEDIUM-002)', () => {
  let service: SessionManagerService;
  let redis: MockRedis;

  const userId = 'user-1';
  const userKey = `session:user:${userId}`;

  beforeEach(async () => {
    redis = createMockRedis();

    const config: Pick<ConfigService, 'get'> = {
      // SESSION_USE_REDIS=true forces the Redis branch; NODE_ENV=test avoids the
      // in-memory-in-production guard. Other keys fall back to their defaults.
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'SESSION_USE_REDIS') return true;
        if (key === 'NODE_ENV') return 'test';
        if (key === 'MAX_SESSIONS_PER_USER') return 5;
        return defaultValue;
      }) as ConfigService['get'],
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SessionManagerService,
        { provide: ConfigService, useValue: config },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(SessionManagerService);
  });

  afterEach(() => {
    // Stop the 5-minute cleanup interval so Jest can exit cleanly.
    service.onModuleDestroy();
    jest.clearAllMocks();
  });

  describe('getUserSessions', () => {
    it('batches reads into a single mget (no per-session get) and preserves tenantId', async () => {
      redis.smembers.mockResolvedValue(['a', 'b', 'c']);
      redis.mget.mockResolvedValue([
        activeSessionJson('a', userId, 3000, 't-1'),
        activeSessionJson('b', userId, 2000),
        activeSessionJson('c', userId, 1000),
      ]);

      const result = await service.getUserSessions(userId);

      // ONE mget over the mapped keys; zero direct gets.
      expect(redis.mget).toHaveBeenCalledTimes(1);
      expect(redis.mget).toHaveBeenCalledWith('session:a', 'session:b', 'session:c');
      expect(redis.get).not.toHaveBeenCalled();

      expect(result).toHaveLength(3);
      // Tenant scoping flows through toSessionInfo unchanged.
      const sessionA = result.find((s) => s.sessionId === 'a') as SessionInfo;
      expect(sessionA.metadata.tenantId).toBe('t-1');
      // lastActivity sort: most-recent first.
      expect(result.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
    });

    it('skips null mget entries (TTL-expired members) without pruning the set', async () => {
      redis.smembers.mockResolvedValue(['a', 'b']);
      redis.mget.mockResolvedValue([null, activeSessionJson('b', userId, 2000)]);

      const result = await service.getUserSessions(userId);

      expect(redis.mget).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result.map((s) => s.sessionId)).toEqual(['b']);
      // Stale SMEMBERS entries are intentionally NOT pruned here.
      expect(redis.srem).not.toHaveBeenCalled();
    });

    it('tolerates a malformed payload (parse failure skipped, no throw)', async () => {
      redis.smembers.mockResolvedValue(['a', 'b']);
      redis.mget.mockResolvedValue(['not-json', activeSessionJson('b', userId, 2000)]);

      const result = await service.getUserSessions(userId);

      expect(result).toHaveLength(1);
      expect(result.map((s) => s.sessionId)).toEqual(['b']);
    });

    it('returns [] without an mget when the user has no sessions', async () => {
      redis.smembers.mockResolvedValue([]);

      const result = await service.getUserSessions(userId);

      expect(result).toEqual([]);
      expect(redis.mget).not.toHaveBeenCalled();
    });

    it('locks the O(1)-reads budget: mget + get calls === 1 for a 3-session user', async () => {
      redis.smembers.mockResolvedValue(['a', 'b', 'c']);
      redis.mget.mockResolvedValue([
        activeSessionJson('a', userId, 3000),
        activeSessionJson('b', userId, 2000),
        activeSessionJson('c', userId, 1000),
      ]);

      await service.getUserSessions(userId);

      const readRoundTrips = redis.mget.mock.calls.length + redis.get.mock.calls.length;
      expect(readRoundTrips).toBe(1);
    });
  });

  describe('revokeAllSessions', () => {
    it('batches deletes into one pipeline exec, excluding the kept session', async () => {
      redis.smembers.mockResolvedValue(['a', 'b', 'c', 'd']);
      redis.mget.mockResolvedValue([
        activeSessionJson('a', userId, 4000),
        activeSessionJson('b', userId, 3000),
        activeSessionJson('c', userId, 2000),
        activeSessionJson('d', userId, 1000),
      ]);

      const pipeline = createMockPipeline([
        [null, 1],
        [null, 1],
        [null, 1],
        [null, 1],
        [null, 1],
        [null, 1],
      ]);
      redis.pipeline.mockReturnValue(pipeline);

      const revoked = await service.revokeAllSessions(userId, 'b');

      expect(revoked).toBe(3);
      // Exactly one pipeline / one exec — not N serial revokes.
      expect(redis.pipeline).toHaveBeenCalledTimes(1);
      expect(pipeline.exec).toHaveBeenCalledTimes(1);

      // del for a/c/d only, never for the kept 'b'.
      const deletedKeys = pipeline.del.mock.calls.map((c) => c[0]);
      expect(deletedKeys).toEqual(['session:a', 'session:c', 'session:d']);
      expect(deletedKeys).not.toContain('session:b');

      // srem against the user set for a/c/d.
      const sremIds = pipeline.srem.mock.calls.map((c) => [c[0], c[1]]);
      expect(sremIds).toEqual([
        [userKey, 'a'],
        [userKey, 'c'],
        [userKey, 'd'],
      ]);

      // No del/srem issued directly outside the pipeline (no serial-loop regression).
      expect(redis.del).not.toHaveBeenCalled();
      expect(redis.srem).not.toHaveBeenCalled();
    });

    it('counts a partial pipeline failure as not-revoked and does not throw', async () => {
      redis.smembers.mockResolvedValue(['a', 'b', 'c']);
      redis.mget.mockResolvedValue([
        activeSessionJson('a', userId, 3000),
        activeSessionJson('b', userId, 2000),
        activeSessionJson('c', userId, 1000),
      ]);

      // Session 'a' (tuples 0,1) ok; 'b' del errors (tuples 2,3); 'c' ok (4,5).
      const pipeline = createMockPipeline([
        [null, 1],
        [null, 1],
        [new Error('redis'), null],
        [null, 1],
        [null, 1],
        [null, 1],
      ]);
      redis.pipeline.mockReturnValue(pipeline);

      const revoked = await service.revokeAllSessions(userId);

      // Only a + c counted; the errored b is excluded.
      expect(revoked).toBe(2);
      expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('enforceSessionLimit', () => {
    it('evicts the oldest sessions in a single pipeline exec', async () => {
      // 7 sessions, limit 5 -> evict the 2 oldest (by lastActivityAt asc).
      const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
      redis.smembers.mockResolvedValue(ids);
      redis.mget.mockResolvedValue(
        ids.map((id, idx) => activeSessionJson(id, userId, (idx + 1) * 1000)),
      );

      // 2 evictions -> 4 commands (del+srem per id).
      const pipeline = createMockPipeline([
        [null, 1],
        [null, 1],
        [null, 1],
        [null, 1],
      ]);
      redis.pipeline.mockReturnValue(pipeline);

      const revokedIds = await service.enforceSessionLimit(userId, 5);

      expect(revokedIds).toHaveLength(2);
      // Oldest first: s1 (1000) and s2 (2000) carry the smallest lastActivityAt.
      expect(revokedIds).toEqual(['s1', 's2']);

      expect(redis.pipeline).toHaveBeenCalledTimes(1);
      expect(pipeline.exec).toHaveBeenCalledTimes(1);
      expect(pipeline.del).toHaveBeenCalledTimes(2);
      expect(pipeline.srem).toHaveBeenCalledTimes(2);

      // No per-id del/srem outside the pipeline.
      expect(redis.del).not.toHaveBeenCalled();
      expect(redis.srem).not.toHaveBeenCalled();
    });

    it('is a no-op when under the limit', async () => {
      redis.smembers.mockResolvedValue(['a', 'b']);
      redis.mget.mockResolvedValue([
        activeSessionJson('a', userId, 2000),
        activeSessionJson('b', userId, 1000),
      ]);

      const revokedIds = await service.enforceSessionLimit(userId, 5);

      expect(revokedIds).toEqual([]);
      expect(redis.pipeline).not.toHaveBeenCalled();
    });
  });
});
