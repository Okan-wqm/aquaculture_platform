/**
 * SENSOR-LOW-008 — the provisioning rate-limit guard counts through a shared
 * RateLimitStore, not a per-instance Map. Here we assert the guard's counting
 * and 429 behaviour, and that a Redis-backed store is used when a RedisService
 * is wired (one shared window across replicas).
 */
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SimpleRateLimitGuard, RATE_LIMIT_KEY, type RateLimitConfig } from '../rate-limit.guard';

const buildContext = (ip: string, path: string): ExecutionContext => {
  const request = { ip, path, url: path, socket: { remoteAddress: ip } };
  const response = { setHeader: jest.fn() };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
  return ctx as never;
};

const reflectorFor = (config: RateLimitConfig): Reflector =>
  ({ getAllAndOverride: (key: string) => (key === RATE_LIMIT_KEY ? config : undefined) }) as never;

describe('SimpleRateLimitGuard shared-store counting (SENSOR-LOW-008)', () => {
  it('rejects once the shared window exceeds the limit', async () => {
    // No RedisService => in-process fallback store; the counting contract is
    // identical to the Redis path.
    const guard = new SimpleRateLimitGuard(reflectorFor({ limit: 2, windowMs: 60_000 }));
    const ctx = buildContext('1.2.3.4', '/install/EDGE-1');

    await expect(guard.canActivate(ctx)).resolves.toBe(true); // 1
    await expect(guard.canActivate(ctx)).resolves.toBe(true); // 2
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException); // 3 > limit

    guard.onModuleDestroy();
  });

  it('uses a Redis-backed atomic counter when a RedisService is present', async () => {
    // Fake RedisService satisfying the RateLimitRedisPort (getClient().eval).
    let counter = 0;
    const evalFn = jest.fn(async () => {
      counter += 1;
      return [counter, 60_000];
    });
    const redisService = {
      getClient: () => ({ eval: evalFn }),
      deletePattern: jest.fn(async () => 0),
    };

    const guard = new SimpleRateLimitGuard(
      reflectorFor({ limit: 1, windowMs: 60_000 }),
      redisService as never,
    );
    const ctx = buildContext('9.9.9.9', '/api/devices/activate');

    await expect(guard.canActivate(ctx)).resolves.toBe(true); // count 1 == limit
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException); // count 2 > limit
    expect(evalFn).toHaveBeenCalledTimes(2); // every decision went through Redis

    guard.onModuleDestroy();
  });
});
