import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import {
  claudeApiRateLimitHitTotal,
  orchestratorCycleBudgetRemainingTokens,
} from '../metrics/orchestrator-metrics';

/**
 * ClaudeApiBudgetService — Phase 12.4 of
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md.
 *
 * Per-cycle token bucket for Claude API calls. Prevents a run-away
 * review cycle from exhausting the tenant's monthly budget or
 * hitting Anthropic's org-wide rate limit in a tight loop.
 *
 * # Protocol
 *
 * - At cycle start, reserve() sets a budget: `orchestrator:budget:
 *   <cycle_id>:<model> = <max_tokens>` with PX = cycle-timeout.
 * - Before EVERY Claude API call, the caller pre-deducts its
 *   estimated cost via `consumePre(cycle, model, estimate)`.
 *   Atomic DECR → if result < 0, the call is REFUSED (returns
 *   `{ allowed: false }`); caller short-circuits.
 * - After the API call, `settle(cycle, model, actualTokens,
 *   estimatedTokens)` adjusts the reservation if the actual cost
 *   differs from the pre-deduction estimate.
 * - On 429 from Anthropic, `record429(model)` increments the
 *   `claude_api_rate_limit_hit_total` counter AND (if the rolling
 *   rate exceeds threshold) flips a global kill-switch:
 *   `orchestrator:emergency-freeze = 1` that every caller reads
 *   before dispatch.
 *
 * # Why redis, not in-memory
 *
 * Phase 12.2 introduces multi-pod deployments. An in-memory
 * budget would let every pod spend the full budget independently —
 * triple-burn. Redis atomic DECR is the standard single-counter-
 * across-cluster primitive.
 *
 * # Fail-CLOSED on Redis outage
 *
 * Redis outage = REFUSE dispatches (return `{ allowed: false,
 * reason: 'redis-unavailable' }`). Silently allowing on outage
 * is the MT-CRITICAL-002 regression class (rate limit escape
 * hatch). The cost of a missed review cycle is lower than the
 * cost of a blown API budget.
 *
 * # Not yet wired
 *
 * The orchestrator-runner + Claude SDK wrapper (apps/ai-service/src/
 * agent/agent-runner.service.ts) do NOT yet call these methods.
 * Wiring is Phase 12.4 completion work; this file establishes the
 * contract.
 */

export interface BudgetReservation {
  cycleId: string;
  model: string;
  maxTokens: number;
  expirySeconds: number;
}

export interface ConsumePreResult {
  allowed: boolean;
  remainingTokens: number;
  reason?: 'redis-unavailable' | 'budget-exhausted' | 'emergency-freeze';
}

export interface ClaudeApiBudgetOptions {
  /**
   * When the rolling 1-min rate of 429s exceeds this threshold,
   * flip the emergency freeze for FREEZE_DURATION_SECONDS.
   * Default 5 hits in 60s.
   */
  emergencyFreezeThreshold?: number;
  /**
   * How long the emergency freeze persists once flipped.
   * Default 5 minutes.
   */
  emergencyFreezeDurationSeconds?: number;
}

const BUDGET_KEY_PREFIX = 'orchestrator:budget:';
const FREEZE_KEY = 'orchestrator:emergency-freeze';
const RATE_LIMIT_WINDOW_KEY_PREFIX = 'orchestrator:429-window:';

@Injectable()
export class ClaudeApiBudgetService {
  private readonly logger = new Logger(ClaudeApiBudgetService.name);
  private readonly emergencyFreezeThreshold: number;
  private readonly emergencyFreezeDurationSeconds: number;

  constructor(
    private readonly redis: Redis,
    options: ClaudeApiBudgetOptions = {},
  ) {
    this.emergencyFreezeThreshold = options.emergencyFreezeThreshold ?? 5;
    this.emergencyFreezeDurationSeconds =
      options.emergencyFreezeDurationSeconds ?? 300;
  }

  /**
   * Reserve a token budget for a review cycle. Idempotent — calling
   * with the same cycleId overwrites the prior reservation
   * (intentional: a restart of a cycle resets the budget).
   */
  async reserve(reservation: BudgetReservation): Promise<void> {
    const key = this.budgetKey(reservation.cycleId, reservation.model);
    try {
      await this.redis.set(
        key,
        String(reservation.maxTokens),
        'EX',
        reservation.expirySeconds,
      );
      orchestratorCycleBudgetRemainingTokens.set(
        { model: reservation.model },
        reservation.maxTokens,
      );
    } catch (err) {
      this.logger.error(
        `reserve failed for ${reservation.cycleId}/${reservation.model}: ${(err as Error).message}`,
      );
      throw err; // Hard-fail on reservation — no budget = no cycle.
    }
  }

  /**
   * Pre-deduct estimated cost before issuing a Claude API call.
   * Caller MUST honour `allowed: false` by NOT making the call.
   *
   * The estimate/actual gap is reconciled via settle() post-call —
   * this keeps the atomic DECR path simple while letting the final
   * accounting be accurate.
   */
  async consumePre(
    cycleId: string,
    model: string,
    estimatedTokens: number,
  ): Promise<ConsumePreResult> {
    if (estimatedTokens < 0) {
      throw new Error('consumePre: estimatedTokens must be >= 0');
    }

    try {
      // First check the emergency freeze — a single GET round-trip.
      const frozen = await this.redis.get(FREEZE_KEY);
      if (frozen === '1') {
        return {
          allowed: false,
          remainingTokens: 0,
          reason: 'emergency-freeze',
        };
      }

      const key = this.budgetKey(cycleId, model);
      // Atomic DECRBY returns the post-decrement value. A negative
      // result means the caller just overdrew; refuse AND add the
      // tokens back so the tally stays honest for the next caller.
      const remaining = await this.redis.decrby(key, estimatedTokens);
      if (remaining < 0) {
        await this.redis.incrby(key, estimatedTokens);
        return {
          allowed: false,
          remainingTokens: 0,
          reason: 'budget-exhausted',
        };
      }
      orchestratorCycleBudgetRemainingTokens.set({ model }, remaining);
      return { allowed: true, remainingTokens: remaining };
    } catch (err) {
      this.logger.error(
        `consumePre Redis error (${cycleId}/${model}): ${(err as Error).message}. Fail-CLOSED.`,
      );
      return {
        allowed: false,
        remainingTokens: 0,
        reason: 'redis-unavailable',
      };
    }
  }

  /**
   * Reconcile the post-call actual cost against the pre-deducted
   * estimate. If actual > estimate, deduct the difference. If
   * actual < estimate, refund. Either way, updates the metric
   * gauge.
   */
  async settle(
    cycleId: string,
    model: string,
    actualTokens: number,
    estimatedTokens: number,
  ): Promise<void> {
    const delta = actualTokens - estimatedTokens; // positive = overspent
    if (delta === 0) return;
    try {
      const key = this.budgetKey(cycleId, model);
      const remaining = await this.redis.decrby(key, delta);
      orchestratorCycleBudgetRemainingTokens.set({ model }, Math.max(0, remaining));
    } catch (err) {
      this.logger.warn(
        `settle Redis error (${cycleId}/${model}): ${(err as Error).message}. Accounting drift.`,
      );
    }
  }

  /**
   * Record a 429 from Anthropic. Increments the per-model counter
   * and checks the rolling-window rate. If the rate exceeds the
   * threshold, flips the emergency freeze.
   */
  async record429(model: string): Promise<void> {
    claudeApiRateLimitHitTotal.inc({ model });
    const windowKey = `${RATE_LIMIT_WINDOW_KEY_PREFIX}${model}`;
    try {
      // Rolling 60-second window: INCR + EXPIRE pair under a single
      // key. Budget-wise this drops old counts when the key expires
      // — the 1-min window is implicit in the 60s TTL.
      const current = await this.redis.incr(windowKey);
      if (current === 1) {
        await this.redis.expire(windowKey, 60);
      }
      if (current >= this.emergencyFreezeThreshold) {
        this.logger.error(
          `Emergency freeze triggered: ${current} 429s for ${model} in the last 60s ` +
            `(threshold=${this.emergencyFreezeThreshold}). Freezing dispatch for ` +
            `${this.emergencyFreezeDurationSeconds}s.`,
        );
        await this.redis.set(
          FREEZE_KEY,
          '1',
          'EX',
          this.emergencyFreezeDurationSeconds,
        );
      }
    } catch (err) {
      this.logger.error(
        `record429 Redis error: ${(err as Error).message}. Freeze status unchanged; manual oncall intervention may be required.`,
      );
    }
  }

  /**
   * Check whether the emergency freeze is active WITHOUT counting
   * against the budget. Used by oncall tooling + health checks.
   */
  async isFrozen(): Promise<boolean> {
    try {
      const v = await this.redis.get(FREEZE_KEY);
      return v === '1';
    } catch {
      // On Redis outage, treat as frozen (fail-CLOSED) — dispatch
      // suppression is safer than Redis-blind dispatch.
      return true;
    }
  }

  /**
   * Manually lift the emergency freeze. Oncall escape hatch when
   * the root cause of the 429 burst has been resolved.
   */
  async liftFreeze(): Promise<void> {
    try {
      await this.redis.del(FREEZE_KEY);
      this.logger.log('Emergency freeze manually lifted.');
    } catch (err) {
      this.logger.error(`liftFreeze Redis error: ${(err as Error).message}`);
      throw err;
    }
  }

  private budgetKey(cycleId: string, model: string): string {
    // Slash-separated keys are ioredis-standard; the prefix scopes
    // the namespace so tenant-unrelated Redis keys cannot collide.
    return `${BUDGET_KEY_PREFIX}${cycleId}:${model}`;
  }
}
