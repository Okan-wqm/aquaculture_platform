import { randomUUID } from 'node:crypto';

export const CDSE_RENDER_GLOBAL_CONCURRENCY = 4;
export const CDSE_RENDER_TENANT_CONCURRENCY = 2;
export const CDSE_RENDER_GLOBAL_QUEUE_LIMIT = 8;
export const CDSE_RENDER_TENANT_QUEUE_LIMIT = 2;
export const CDSE_RENDER_DISTRIBUTED_LEASE_MS = 240_000;
export const CDSE_RENDER_REDIS_TIMEOUT_MS = 2_000;

const GLOBAL_LEASE_KEY = 'farm:cdse-render:v1:global';
const ACQUIRE_DISTRIBUTED_LEASE = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local ownerToken = ARGV[3]
local globalLimit = tonumber(ARGV[4])
local tenantLimit = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('EXISTS', KEYS[3]) == 1 then
  return -1
end
if redis.call('ZCARD', KEYS[1]) >= globalLimit or redis.call('ZCARD', KEYS[2]) >= tenantLimit then
  return 0
end
local locked = redis.call('SET', KEYS[3], ownerToken, 'PX', ${CDSE_RENDER_DISTRIBUTED_LEASE_MS}, 'NX')
if not locked then
  return -1
end
redis.call('ZADD', KEYS[1], expiresAt, ownerToken)
redis.call('ZADD', KEYS[2], expiresAt, ownerToken)
redis.call('PEXPIRE', KEYS[1], ${CDSE_RENDER_DISTRIBUTED_LEASE_MS + 10_000})
redis.call('PEXPIRE', KEYS[2], ${CDSE_RENDER_DISTRIBUTED_LEASE_MS + 10_000})
return 1
`;
const RELEASE_DISTRIBUTED_LEASE = `
if redis.call('GET', KEYS[3]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

export interface CdseRenderRedisPort {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export class CdseRenderAdmissionError extends Error {
  constructor(readonly reason: 'SATURATED' | 'DUPLICATE' | 'CANCELLED' | 'UNAVAILABLE') {
    super(
      reason === 'DUPLICATE'
        ? 'An identical CDSE render is already in progress'
        : reason === 'UNAVAILABLE'
          ? 'Distributed CDSE render admission is unavailable'
          : reason === 'SATURATED'
            ? 'CDSE render capacity is saturated'
            : 'CDSE render admission was cancelled',
    );
    this.name = 'CdseRenderAdmissionError';
  }
}

interface QueuedAdmission {
  readonly tenantId: string;
  readonly flightKey: string;
  readonly signal?: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: CdseRenderAdmissionError) => void;
  readonly onAbort?: () => void;
}

/**
 * Fleet-wide bounded admission for the shared company CDSE render quota.
 *
 * A process-local queue prevents one pod from overcommitting its own event loop.
 * An atomic Redis sorted-set lease applies the same global/tenant caps across
 * every farm-service replica and suppresses identical requests across pods.
 * Leases outlive the aggregate gateway deadline and expire after a crash.
 */
export class CdseRenderAdmission {
  private globalActive = 0;
  private readonly tenantActive = new Map<string, number>();
  private readonly admittedFlightKeys = new Set<string>();
  private readonly queue: QueuedAdmission[] = [];

  constructor(
    private readonly redis?: CdseRenderRedisPort,
    private readonly requireDistributed = process.env['NODE_ENV'] === 'production',
  ) {}

  async acquire(tenantId: string, flightKey: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new CdseRenderAdmissionError('CANCELLED');
    }
    if (this.admittedFlightKeys.has(flightKey)) {
      throw new CdseRenderAdmissionError('DUPLICATE');
    }
    this.admittedFlightKeys.add(flightKey);
    if (this.canAdmit(tenantId)) {
      return this.grantWithDistributedLease(tenantId, flightKey, signal);
    }
    if (
      this.queue.length >= CDSE_RENDER_GLOBAL_QUEUE_LIMIT ||
      this.queue.filter((entry) => entry.tenantId === tenantId).length >=
        CDSE_RENDER_TENANT_QUEUE_LIMIT
    ) {
      this.admittedFlightKeys.delete(flightKey);
      throw new CdseRenderAdmissionError('SATURATED');
    }

    return new Promise<() => void>((resolve, reject) => {
      const queued: QueuedAdmission = {
        tenantId,
        flightKey,
        signal,
        resolve,
        reject,
        ...(signal
          ? {
              onAbort: (): void => {
                const index = this.queue.indexOf(queued);
                if (index >= 0) {
                  this.queue.splice(index, 1);
                  this.admittedFlightKeys.delete(flightKey);
                  reject(new CdseRenderAdmissionError('CANCELLED'));
                }
              },
            }
          : {}),
      };
      if (signal && queued.onAbort) {
        signal.addEventListener('abort', queued.onAbort, { once: true });
      }
      this.queue.push(queued);
    });
  }

  private canAdmit(tenantId: string): boolean {
    return (
      this.globalActive < CDSE_RENDER_GLOBAL_CONCURRENCY &&
      (this.tenantActive.get(tenantId) ?? 0) < CDSE_RENDER_TENANT_CONCURRENCY
    );
  }

  private grant(tenantId: string, flightKey: string): () => void {
    this.globalActive += 1;
    this.tenantActive.set(tenantId, (this.tenantActive.get(tenantId) ?? 0) + 1);
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.admittedFlightKeys.delete(flightKey);
      this.globalActive -= 1;
      const remaining = (this.tenantActive.get(tenantId) ?? 1) - 1;
      if (remaining === 0) {
        this.tenantActive.delete(tenantId);
      } else {
        this.tenantActive.set(tenantId, remaining);
      }
      this.drain();
    };
  }

  private drain(): void {
    while (this.globalActive < CDSE_RENDER_GLOBAL_CONCURRENCY) {
      const index = this.queue.findIndex((entry) => this.canAdmit(entry.tenantId));
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      if (!entry) return;
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      if (entry.signal?.aborted) {
        this.admittedFlightKeys.delete(entry.flightKey);
        entry.reject(new CdseRenderAdmissionError('CANCELLED'));
        continue;
      }
      void this.grantWithDistributedLease(entry.tenantId, entry.flightKey, entry.signal).then(
        entry.resolve,
        entry.reject,
      );
    }
  }

  private async grantWithDistributedLease(
    tenantId: string,
    flightKey: string,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const releaseLocal = this.grant(tenantId, flightKey);
    try {
      const distributedOwner = await this.acquireDistributed(tenantId, flightKey);
      if (signal?.aborted) {
        if (distributedOwner) {
          void this.releaseDistributed(tenantId, flightKey, distributedOwner);
        }
        throw new CdseRenderAdmissionError('CANCELLED');
      }
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        releaseLocal();
        if (distributedOwner) {
          void this.releaseDistributed(tenantId, flightKey, distributedOwner);
        }
      };
    } catch (error) {
      releaseLocal();
      throw error;
    }
  }

  private async acquireDistributed(tenantId: string, flightKey: string): Promise<string | null> {
    if (!this.redis) {
      if (this.requireDistributed) {
        throw new CdseRenderAdmissionError('UNAVAILABLE');
      }
      return null;
    }
    const now = Date.now();
    const ownerToken = randomUUID();
    let result: unknown;
    try {
      result = await this.withRedisTimeout(
        this.redis.eval(
          ACQUIRE_DISTRIBUTED_LEASE,
          3,
          GLOBAL_LEASE_KEY,
          this.tenantLeaseKey(tenantId),
          this.flightLeaseKey(flightKey),
          now,
          now + CDSE_RENDER_DISTRIBUTED_LEASE_MS,
          ownerToken,
          CDSE_RENDER_GLOBAL_CONCURRENCY,
          CDSE_RENDER_TENANT_CONCURRENCY,
        ),
      );
    } catch {
      if (this.requireDistributed) {
        throw new CdseRenderAdmissionError('UNAVAILABLE');
      }
      return null;
    }
    const code = Number(result);
    if (code === 1) return ownerToken;
    if (code === -1) throw new CdseRenderAdmissionError('DUPLICATE');
    if (code === 0) throw new CdseRenderAdmissionError('SATURATED');
    throw new CdseRenderAdmissionError('UNAVAILABLE');
  }

  private async releaseDistributed(
    tenantId: string,
    flightKey: string,
    ownerToken: string,
  ): Promise<void> {
    try {
      if (!this.redis) return;
      await this.withRedisTimeout(
        this.redis.eval(
          RELEASE_DISTRIBUTED_LEASE,
          3,
          GLOBAL_LEASE_KEY,
          this.tenantLeaseKey(tenantId),
          this.flightLeaseKey(flightKey),
          ownerToken,
        ),
      );
    } catch {
      // The bounded lease expires automatically; never resurrect or transfer it.
    }
  }

  private tenantLeaseKey(tenantId: string): string {
    return `farm:cdse-render:v1:tenant:${tenantId}`;
  }

  private flightLeaseKey(flightKey: string): string {
    return `farm:cdse-render:v1:flight:${flightKey}`;
  }

  private async withRedisTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new CdseRenderAdmissionError('UNAVAILABLE')),
        CDSE_RENDER_REDIS_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
}
