/**
 * LeaderElectionService unit tests — Phase 12.2.
 *
 * Exercises the Redlock-lite protocol with an in-memory Redis mock
 * that implements the ioredis surface the service touches:
 * SET key val NX PX, SET key val XX PX, GET, PTTL, EVAL (for
 * CONDITIONAL_DEL_LUA). Tests the critical correctness properties:
 *
 *   1. Exactly one leader across N pods (concurrency).
 *   2. Step-down on lost lease (another pod won the race).
 *   3. Step-down on Redis outage.
 *   4. Graceful release on module destroy.
 *   5. assertLeadershipFresh refuses stale belief.
 */

import type Redis from 'ioredis';

import { LeaderElectionService } from './leader-election.service';

/**
 * Minimal in-memory mock of the ioredis API surface used by
 * LeaderElectionService. Not a full Redis — only the commands the
 * service issues. Time-dependent behaviour (PX expiry) is jest-
 * timer driven.
 *
 * The class does NOT `implements` a structural Pick<Redis, ...> type
 * because ioredis declares set / eval with complex overloaded
 * signatures (16+ overloads each) that an in-memory test mock can't
 * narrow to. The downstream `r as unknown as Redis` cast at the
 * service-construction site (line ~109) is the boundary; everything
 * inside FakeRedis stays a simple test double. Surfaced by PR-29
 * (PROC-MEDIUM-007 ratchet) — the previous `implements RedisLike`
 * declaration tripped strict-tsc on overload incompatibility.
 */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  private outage = false;

  setOutage(on: boolean): void {
    this.outage = on;
  }

  private checkExpiry(key: string): void {
    const row = this.store.get(key);
    if (row && row.expiresAt !== null && Date.now() >= row.expiresAt) {
      this.store.delete(key);
    }
  }

  // Narrow wrapper matching the SET signatures the service invokes:
  //   redis.set(key, value, 'PX', ms, 'NX')
  //   redis.set(key, value, 'PX', ms, 'XX')
  // Both invocations have the same argument shape.
  set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (this.outage) return Promise.reject(new Error('Redis outage (mock)'));
    this.checkExpiry(key);
    const pxIdx = args.findIndex((a) => a === 'PX');
    const ms = pxIdx >= 0 ? Number(args[pxIdx + 1]) : null;
    const nx = args.includes('NX');
    const xx = args.includes('XX');
    const existing = this.store.get(key);
    if (nx && existing) return Promise.resolve(null);
    if (xx && !existing) return Promise.resolve(null);
    const expiresAt = ms ? Date.now() + ms : null;
    this.store.set(key, { value, expiresAt });
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    if (this.outage) return Promise.reject(new Error('Redis outage (mock)'));
    this.checkExpiry(key);
    return Promise.resolve(this.store.get(key)?.value ?? null);
  }

  pttl(key: string): Promise<number> {
    if (this.outage) return Promise.reject(new Error('Redis outage (mock)'));
    this.checkExpiry(key);
    const row = this.store.get(key);
    if (!row || row.expiresAt === null) return Promise.resolve(-1);
    return Promise.resolve(Math.max(0, row.expiresAt - Date.now()));
  }

  eval(_script: string, _numKeys: number, key: string, value: string): Promise<number> {
    // Matches CONDITIONAL_DEL_LUA semantics: DEL iff GET == value.
    if (this.outage) return Promise.reject(new Error('Redis outage (mock)'));
    this.checkExpiry(key);
    const current = this.store.get(key);
    if (current?.value === value) {
      this.store.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }

  _advanceTime(ms: number): void {
    // Rewrite expiresAt so the next checkExpiry evicts expired rows
    // — lets tests simulate clock advance without real delays.
    for (const [k, row] of this.store.entries()) {
      if (row.expiresAt !== null) {
        row.expiresAt -= ms;
      }
      void k;
    }
  }
}

function svc(r: FakeRedis, podId: string): LeaderElectionService {
  return new LeaderElectionService(r as unknown as Redis, {
    podId,
    leaseKey: 'test:lease',
    leaseDurationMs: 30_000,
    renewIntervalMs: 10_000,
  });
}

describe('LeaderElectionService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('acquires lease on first tryAcquire when no leader exists', async () => {
    const redis = new FakeRedis();
    const s = svc(redis, 'pod-A');
    await s.onModuleInit();
    expect(s.isLeader()).toBe(true);
    await s.onModuleDestroy();
  });

  it('exactly one of N concurrent pods wins leadership', async () => {
    const redis = new FakeRedis();
    const pods = [svc(redis, 'pod-A'), svc(redis, 'pod-B'), svc(redis, 'pod-C')];
    await Promise.all(pods.map((p) => p.onModuleInit()));
    const leaderCount = pods.filter((p) => p.isLeader()).length;
    expect(leaderCount).toBe(1);
    await Promise.all(pods.map((p) => p.onModuleDestroy()));
  });

  it('non-leader pod stays observer while leader holds lease', async () => {
    const redis = new FakeRedis();
    const leader = svc(redis, 'pod-A');
    await leader.onModuleInit();
    expect(leader.isLeader()).toBe(true);

    const follower = svc(redis, 'pod-B');
    await follower.onModuleInit();
    expect(follower.isLeader()).toBe(false);

    await leader.onModuleDestroy();
    await follower.onModuleDestroy();
  });

  it('follower acquires leadership after former leader releases on destroy', async () => {
    const redis = new FakeRedis();
    const leader = svc(redis, 'pod-A');
    await leader.onModuleInit();
    expect(leader.isLeader()).toBe(true);

    const follower = svc(redis, 'pod-B');
    await follower.onModuleInit();
    expect(follower.isLeader()).toBe(false);

    // Graceful step-down: leader destroy conditionally-DEL-releases
    // the lease; follower's next tryAcquire should succeed.
    await leader.onModuleDestroy();
    // Simulate follower's renewTimer firing by calling the private
    // method via its public side-effect (re-run onModuleInit is
    // cleaner).
    await (follower as unknown as { tryAcquire: () => Promise<void> }).tryAcquire();
    expect(follower.isLeader()).toBe(true);
    await follower.onModuleDestroy();
  });

  it('assertLeadershipFresh returns false when lease belongs to another pod', async () => {
    const redis = new FakeRedis();
    const leader = svc(redis, 'pod-A');
    await leader.onModuleInit();

    // Simulate cross-pod preemption: pod-B somehow forces overwrite
    // (via a full DEL + SET-NX race window). Our leader's belief is
    // stale until the next check.
    await redis.eval('_', 1, 'test:lease', 'pod-A'); // release
    await redis.set('test:lease', 'pod-B', 'PX', 30_000, 'NX');

    const fresh = await leader.assertLeadershipFresh(5_000);
    expect(fresh).toBe(false);
    expect(leader.isLeader()).toBe(false);
    await leader.onModuleDestroy();
  });

  it('assertLeadershipFresh returns false when lease is expiring too soon', async () => {
    const redis = new FakeRedis();
    const leader = svc(redis, 'pod-A');
    await leader.onModuleInit();

    // Advance time so only 4s remain on the lease.
    redis._advanceTime(26_000);
    const fresh = await leader.assertLeadershipFresh(5_000);
    expect(fresh).toBe(false);
    await leader.onModuleDestroy();
  });

  it('steps down when Redis outage prevents re-assertion', async () => {
    const redis = new FakeRedis();
    const leader = svc(redis, 'pod-A');
    await leader.onModuleInit();
    expect(leader.isLeader()).toBe(true);

    redis.setOutage(true);
    await (leader as unknown as { tryAcquire: () => Promise<void> }).tryAcquire();
    expect(leader.isLeader()).toBe(false);
    redis.setOutage(false);
    await leader.onModuleDestroy();
  });

  it('refuses to construct when renewInterval >= leaseDuration', () => {
    const redis = new FakeRedis();
    expect(
      () =>
        new LeaderElectionService(redis as unknown as Redis, {
          podId: 'pod-bad',
          leaseDurationMs: 10_000,
          renewIntervalMs: 10_000,
        }),
    ).toThrow(/renewIntervalMs.*must be strictly less than leaseDurationMs/);
  });
});
