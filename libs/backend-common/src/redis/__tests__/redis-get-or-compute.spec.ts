/**
 * RedisService.getOrCompute — single-flight read-through (no-stampede SSoT).
 *
 * Proves the stampede-protection contract: on a miss exactly ONE caller
 * recomputes while concurrent callers wait for its result; null is not cached;
 * and every Redis fault degrades to a direct compute (fail-open). The real
 * single-flight LOGIC lives here — the cache interceptor + ai-insights only
 * delegate to it, so this is the authoritative test for the behaviour.
 *
 * The Redis I/O primitives (getJson/setNx/setJson/del) are spied onto a tiny
 * in-memory store so the logic runs without a live Redis. The constructor opens
 * a (never-used) client against a dead port; afterEach force-disconnects it so
 * no socket handle leaks.
 */
import { RedisService } from '../redis.service';

interface Harness {
  svc: RedisService;
  store: Map<string, string>;
  locks: Set<string>;
  failReadsOnce: () => void;
}

function makeHarness(): Harness {
  // Dead port — the client is never exercised (every primitive is spied).
  const svc = new RedisService({ host: '127.0.0.1', port: 6399 });
  const store = new Map<string, string>();
  const locks = new Set<string>();
  let readShouldThrow = false;

  jest.spyOn(svc, 'getJson').mockImplementation(async (key: string) => {
    if (readShouldThrow) {
      readShouldThrow = false;
      throw new Error('redis read boom');
    }
    const raw = store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  });
  jest
    .spyOn(svc, 'setJson')
    .mockImplementation(async (key: string, value: unknown) => {
      store.set(key, JSON.stringify(value));
    });
  jest.spyOn(svc, 'setNx').mockImplementation(async (key: string) => {
    if (locks.has(key)) return false;
    locks.add(key);
    return true;
  });
  jest.spyOn(svc, 'del').mockImplementation(async (key: string) => {
    const had = locks.delete(key) || store.delete(key);
    return had ? 1 : 0;
  });

  return {
    svc,
    store,
    locks,
    failReadsOnce: () => {
      readShouldThrow = true;
    },
  };
}

describe('RedisService.getOrCompute (single-flight read-through)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    // Force-close the never-connected client so no retry timer/socket leaks.
    h.svc.getClient().disconnect();
    jest.restoreAllMocks();
  });

  it('returns the cached value on a hit without computing', async () => {
    h.store.set('k', JSON.stringify({ v: 1 }));
    const compute = jest.fn().mockResolvedValue({ v: 2 });

    const result = await h.svc.getOrCompute('k', 60, compute);

    expect(result).toEqual({ v: 1 });
    expect(compute).not.toHaveBeenCalled();
  });

  it('computes + caches on a miss, then serves the cached value', async () => {
    const compute = jest.fn().mockResolvedValue({ v: 7 });

    const first = await h.svc.getOrCompute('k', 60, compute);
    expect(first).toEqual({ v: 7 });
    expect(h.store.has('k')).toBe(true);

    const second = await h.svc.getOrCompute('k', 60, compute);
    expect(second).toEqual({ v: 7 });
    expect(compute).toHaveBeenCalledTimes(1); // second was a hit
  });

  it('single-flights: N concurrent misses on the same key compute exactly once', async () => {
    const compute = jest.fn().mockImplementation(async () => {
      await Promise.resolve();
      return { v: 'computed' };
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.svc.getOrCompute('k', 60, compute, {
          pollIntervalMs: 5,
          maxWaitMs: 1000,
        }),
      ),
    );

    expect(compute).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual({ v: 'computed' });
  });

  it('a lock-loser returns the winner-written value without computing', async () => {
    // Pre-seed the lock as held by another worker, and have that worker's
    // result appear after the first poll.
    h.locks.add('k:sf-lock');
    const compute = jest.fn().mockResolvedValue({ v: 'mine' });
    setTimeout(() => h.store.set('k', JSON.stringify({ v: 'winner' })), 10);

    const result = await h.svc.getOrCompute('k', 60, compute, {
      pollIntervalMs: 5,
      maxWaitMs: 1000,
    });

    expect(result).toEqual({ v: 'winner' });
    expect(compute).not.toHaveBeenCalled();
  });

  it('falls back to a direct compute when the winner never fills before the deadline', async () => {
    h.locks.add('k:sf-lock'); // lock held, value never written
    const compute = jest.fn().mockResolvedValue({ v: 'fallback' });

    const result = await h.svc.getOrCompute('k', 60, compute, {
      pollIntervalMs: 5,
      maxWaitMs: 30,
    });

    expect(result).toEqual({ v: 'fallback' });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a null/undefined compute result', async () => {
    const compute = jest.fn().mockResolvedValue(null);

    const result = await h.svc.getOrCompute('k', 60, compute);

    expect(result).toBeNull();
    expect(h.store.has('k')).toBe(false);
  });

  it('fails open to a direct compute when the cache read throws', async () => {
    h.failReadsOnce();
    const compute = jest.fn().mockResolvedValue({ v: 'open' });

    const result = await h.svc.getOrCompute('k', 60, compute);

    expect(result).toEqual({ v: 'open' });
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
