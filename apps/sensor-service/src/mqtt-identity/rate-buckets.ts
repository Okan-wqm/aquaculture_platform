/**
 * A token bucket per key, in memory: `burst` messages at once, refilled at
 * `perSecond`. Bounded: past `maxKeys` the least recently seen key is
 * forgotten (it starts again with a full bucket), so a flood of distinct keys
 * cannot grow memory.
 */
export class RateBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly maxKeys: number,
  ) {}

  /** Take one token for `key` at `now` (ms); false when the bucket is empty. */
  take(key: string, now: number): boolean {
    const bucket = this.buckets.get(key);
    const tokens =
      bucket === undefined
        ? this.burst
        : Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond);
    // Re-insert so iteration order is least recently seen first.
    this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) {
        this.buckets.delete(oldest);
      }
    }
    const allowed = tokens >= 1;
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at: now });
    return allowed;
  }
}
