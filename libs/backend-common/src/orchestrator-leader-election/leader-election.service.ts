import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * LeaderElectionService — Phase 12.2 of
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md.
 *
 * Redlock-lite leader election for multi-pod K8s orchestrator deployments.
 * One pod holds the leader lease; others observe.
 *
 * # Why we need this
 *
 * Pre-K8s (Docker Compose + single instance) the orchestrator cycle
 * machinery runs in exactly one process — no contention. When the
 * agent-review loop moves to K8s (Phase 12 BLOCKER), N replicas will
 * all try to claim the next cycle. Without leader election:
 *
 *   - Multiple pods dispatch the same review concurrently → wasted
 *     Claude API budget + conflicting finding-registry writes (hash
 *     chain race despite the advisory-lock serialisation).
 *   - Finding-registry state sweep (Phase 6 cron) runs N times per
 *     day → N race windows on each OPEN → STALE transition.
 *
 * # Protocol (Redlock-lite, single-cluster)
 *
 * `SET orchestrator:leader-lease <pod-id> NX PX 30000` on a fixed
 * schedule (every 10s). The pod that succeeds is the leader; others
 * see the existing lease and remain observers. The leader re-asserts
 * every 10s (lease is 30s = 3× safety window). If the leader pod
 * dies, its lease expires after ~30s and another pod wins the next
 * SET-NX race.
 *
 * Step-down: on graceful shutdown (OnModuleDestroy) the leader
 * DEL-LUA-guarded releases the lease so the next pod can take over
 * within <1s instead of waiting for expiry.
 *
 * # Why not etcd / full Redlock / K8s Lease
 *
 *   - etcd: requires etcd cluster. Our Redis is already deployed +
 *     operator-familiar. Redis single-cluster SET-NX-PX is correct
 *     for our "one leader per cluster" invariant — full Redlock's
 *     quorum across 5 independent Redis instances is for defending
 *     against single-cluster failure, which we handle via K8s pod
 *     restart.
 *   - Lease API (K8s): ties agent orchestration to the K8s control
 *     plane — a correctness dependency we explicitly want to keep
 *     out of the application layer. Redis is cluster-agnostic so
 *     the same protocol runs in Docker Compose dev + K8s prod +
 *     any future orchestrator substrate.
 *
 * # Consumers
 *
 *   - orchestrator-metrics-exporter (Phase 12.3) — only leader emits
 *     `orchestrator_cycle_in_flight` gauge to avoid triple-counting.
 *   - finding-state-sweep cron (Phase 6) — only leader runs the
 *     daily sweep so finding transitions are single-writer.
 *   - any future agent-dispatch worker — consults isLeader() before
 *     taking the next cycle from the queue.
 *
 * # Health exposure
 *
 *   isLeader() is safe to call from HTTP handlers + NestJS guards.
 *   Returns a snapshot of the current in-memory belief; actual
 *   Redis assertion happens in the background loop. The typical
 *   staleness window is <100ms (the SET-NX-PX roundtrip).
 *
 * # Failure modes + correctness
 *
 *   - Redis transient outage: every pod falls back to NON-leader.
 *     Zero dispatches happen until Redis returns. The SLO for agent
 *     review is "minutes, not seconds" so a 30s Redis blip = no
 *     correctness issue, just pause.
 *   - Clock skew between pods: PX expiry is a server-side clock
 *     reading. Pod-side clock only matters for re-assert scheduling.
 *     Skew up to the lease duration (30s) is tolerable.
 *   - Network partition that isolates the leader from Redis but
 *     not from workers: leader believes it's leader for up to 30s
 *     after losing Redis. This is the "Redis re-entrancy" class.
 *     Mitigated by gating external side-effects on a freshness
 *     probe (see `assertLeadershipFresh()` — TODO in Phase 12.2
 *     finalization: external dispatch MUST call this before the
 *     call, not rely on cached isLeader()).
 *
 * # Not yet wired
 *
 *   The orchestrator-runner + finding-state-sweep do NOT yet call
 *   this service. Wiring is Phase 12.2 completion work (follow-up
 *   commit). This file establishes the contract so the wiring has
 *   a stable interface.
 */

export interface LeaderElectionOptions {
  /** Unique per-pod identity. Default: process.env.HOSTNAME || PID */
  podId?: string;
  /** Redis key for the lease. Default: 'orchestrator:leader-lease' */
  leaseKey?: string;
  /** Lease duration in milliseconds. Default: 30000 (30s) */
  leaseDurationMs?: number;
  /** Re-assert interval in milliseconds. Default: 10000 (10s) */
  renewIntervalMs?: number;
}

/**
 * Lua script for conditional DEL — only removes the lease if this
 * pod owns it. Prevents a revived former-leader from stomping on
 * the current leader during step-down races.
 */
const CONDITIONAL_DEL_LUA = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderElectionService.name);
  private readonly podId: string;
  private readonly leaseKey: string;
  private readonly leaseDurationMs: number;
  private readonly renewIntervalMs: number;

  private leaderState = false;
  private renewTimer: NodeJS.Timeout | null = null;
  private stoppedAt: number | null = null;

  constructor(
    private readonly redis: Redis,
    options: LeaderElectionOptions = {},
  ) {
    this.podId =
      options.podId ?? process.env['HOSTNAME'] ?? `pid-${process.pid}`;
    this.leaseKey = options.leaseKey ?? 'orchestrator:leader-lease';
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.renewIntervalMs = options.renewIntervalMs ?? 10_000;

    if (this.renewIntervalMs >= this.leaseDurationMs) {
      throw new Error(
        `LeaderElectionService: renewIntervalMs (${this.renewIntervalMs}) ` +
          `must be strictly less than leaseDurationMs (${this.leaseDurationMs}). ` +
          `The leader needs time to re-assert before the lease expires.`,
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.tryAcquire();
    this.renewTimer = setInterval(() => {
      void this.tryAcquire();
    }, this.renewIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.leaderState) {
      try {
        const released = (await this.redis.eval(
          CONDITIONAL_DEL_LUA,
          1,
          this.leaseKey,
          this.podId,
        )) as number;
        if (released === 1) {
          this.logger.log(`Leader ${this.podId} released lease on shutdown.`);
        }
      } catch (err) {
        this.logger.warn(
          `Failed to release leader lease on shutdown: ${(err as Error).message}`,
        );
      }
      this.leaderState = false;
    }
    this.stoppedAt = Date.now();
  }

  /**
   * Snapshot of leadership belief. Cheap, synchronous, safe from
   * any request handler.
   *
   * External side-effects (Claude API dispatch, finding-registry
   * mutation, cron execution) SHOULD additionally call
   * `assertLeadershipFresh()` to avoid acting on a stale belief if
   * Redis has been unreachable for >leaseDurationMs.
   */
  isLeader(): boolean {
    return this.leaderState;
  }

  /**
   * Round-trip to Redis to verify that THIS pod still holds the
   * lease AND the lease has at least `requiredRemainingMs` of
   * life left. Use before any side-effect that must not be
   * triple-fired across leader churn.
   */
  async assertLeadershipFresh(requiredRemainingMs = 5_000): Promise<boolean> {
    try {
      const [value, ttl] = await Promise.all([
        this.redis.get(this.leaseKey),
        this.redis.pttl(this.leaseKey),
      ]);
      if (value !== this.podId) {
        if (this.leaderState) {
          this.logger.warn(
            `assertLeadershipFresh: lease owner is ${value ?? '<empty>'}, not this pod ${this.podId}. Stepping down.`,
          );
          this.leaderState = false;
        }
        return false;
      }
      if (typeof ttl !== 'number' || ttl < requiredRemainingMs) {
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `assertLeadershipFresh: Redis error: ${(err as Error).message}. Treating as non-leader.`,
      );
      this.leaderState = false;
      return false;
    }
  }

  /**
   * Background SET-NX-PX attempt. Idempotent — running it from
   * multiple pods per renewIntervalMs produces exactly one leader.
   */
  private async tryAcquire(): Promise<void> {
    try {
      // `SET key value NX PX duration` — atomic conditional set + expiry.
      const result = await this.redis.set(
        this.leaseKey,
        this.podId,
        'PX',
        this.leaseDurationMs,
        'NX',
      );
      if (result === 'OK') {
        if (!this.leaderState) {
          this.logger.log(`Pod ${this.podId} acquired leader lease.`);
        }
        this.leaderState = true;
        return;
      }

      // Lease exists. Check if it's ours (we are re-asserting).
      const currentOwner = await this.redis.get(this.leaseKey);
      if (currentOwner === this.podId) {
        // Re-extend our own lease (XX = only set if key exists).
        await this.redis.set(
          this.leaseKey,
          this.podId,
          'PX',
          this.leaseDurationMs,
          'XX',
        );
        this.leaderState = true;
        return;
      }

      // Someone else holds it.
      if (this.leaderState) {
        this.logger.warn(
          `Pod ${this.podId} lost lease to ${currentOwner}. Stepping down.`,
        );
      }
      this.leaderState = false;
    } catch (err) {
      if (this.leaderState) {
        this.logger.warn(
          `tryAcquire Redis error: ${(err as Error).message}. Stepping down.`,
        );
      }
      this.leaderState = false;
    }
  }

  /** Visible for testing. */
  getPodId(): string {
    return this.podId;
  }

  /** Visible for testing. */
  getStoppedAt(): number | null {
    return this.stoppedAt;
  }
}
