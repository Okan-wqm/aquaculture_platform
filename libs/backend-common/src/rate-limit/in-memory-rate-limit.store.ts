import { clearManagedTimer, createManagedInterval, type ManagedInterval } from '../utils';

import { RateLimitEntry, RateLimitIncrementResult, RateLimitStore } from './rate-limit.types';

/**
 * Single-process fallback store.
 *
 * WHY it exists: local development and unit tests must not require Redis.
 * WHY it is NOT enough for production: counters are per-process, so N
 * replicas multiply every limit by N. The module's forRoot wiring prefers
 * the Redis store whenever a RedisService is available; production deploys
 * that end up on this store are a configuration error, which the guard logs
 * loudly once at startup via the module.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, RateLimitEntry>();
  private cleanupInterval: ManagedInterval | null;

  constructor(cleanupIntervalMs = 60_000) {
    this.cleanupInterval = createManagedInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  // WHAT atomicity means here: Node executes this method body without
  // interleaving (single-threaded sync section), so check-and-increment is
  // race-free within the process — the same guarantee the Lua script gives
  // the Redis store across processes.
  incrementOrCreate(key: string, windowMs: number): Promise<RateLimitIncrementResult> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetTime) {
      const entry: RateLimitEntry = { count: 1, resetTime: now + windowMs };
      this.windows.set(key, entry);
      return Promise.resolve({ entry, isNew: true });
    }

    existing.count += 1;
    return Promise.resolve({ entry: existing, isNew: false });
  }

  isHealthy(): boolean {
    return true;
  }

  clear(): Promise<void> {
    this.windows.clear();
    return Promise.resolve();
  }

  destroy(): void {
    clearManagedTimer(this.cleanupInterval);
    this.cleanupInterval = null;
    this.windows.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (now >= entry.resetTime) {
        this.windows.delete(key);
      }
    }
  }
}
