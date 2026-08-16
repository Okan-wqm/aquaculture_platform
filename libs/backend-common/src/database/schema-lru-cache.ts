/**
 * LRU cache for tenant schema existence checks with split TTL.
 *
 * Positive entries (schema exists) use a longer TTL (default 5 minutes)
 * because schemas are rarely deleted.
 *
 * Negative entries (schema does not exist) use a shorter TTL (default 30 seconds)
 * so newly provisioned tenants are detected quickly.
 *
 * Enterprise-grade: includes request coalescing to prevent thundering herd
 * on cache misses (multiple concurrent requests for the same uncached schema).
 */
export class SchemaLRUCache {
  private cache = new Map<string, { exists: boolean; expiry: number }>();
  private pendingChecks = new Map<string, Promise<boolean>>();

  constructor(
    private readonly maxSize = 1000,
    private readonly positiveTtlMs: number = 5 * 60 * 1000, // 5 minutes
    private readonly negativeTtlMs: number = 30 * 1000, // 30 seconds
  ) {}

  get(key: string): boolean | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: move to end
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.exists;
  }

  set(key: string, exists: boolean): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest (first) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    const ttl = exists ? this.positiveTtlMs : this.negativeTtlMs;
    this.cache.set(key, { exists, expiry: Date.now() + ttl });
  }

  /**
   * Check schema existence with request coalescing.
   * Prevents N concurrent requests from firing N identical DB queries.
   */
  async getOrCheck(key: string, checker: () => Promise<boolean>): Promise<boolean> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    // Request coalescing: if another request is already checking, wait for it
    const pending = this.pendingChecks.get(key);
    if (pending) return pending;

    const check = checker()
      .then((exists) => {
        this.set(key, exists);
        this.pendingChecks.delete(key);
        return exists;
      })
      .catch((err) => {
        this.pendingChecks.delete(key);
        throw err;
      });

    this.pendingChecks.set(key, check);
    return check;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
    this.pendingChecks.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.pendingChecks.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
