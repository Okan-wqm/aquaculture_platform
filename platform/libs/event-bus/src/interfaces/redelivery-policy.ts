import { redeliveryBackoffMs } from './handler-outcome';

/**
 * A consumer's redelivery budget: how many deliveries before the message is
 * dead-lettered, and the cap of one backoff step.
 */
export interface RedeliveryPolicy {
  /** Deliveries (the first included) before a still-failing message is dead-lettered. */
  readonly maxDeliveries: number;
  /** Cap of one exponential backoff step. */
  readonly maxBackoffMs: number;
}

/** Total time a message waits between its first and its last delivery. */
export function redeliverySpanMs(policy: RedeliveryPolicy): number {
  let total = 0;
  for (let delivery = 1; delivery < policy.maxDeliveries; delivery++) {
    total += redeliveryBackoffMs(delivery, policy.maxBackoffMs);
  }
  return total;
}

/**
 * The smallest budget whose redeliveries span at least `minimumSpanMs`, with
 * backoff steps capped at `maxBackoffMs`. Derived, never hand-counted, so the
 * guarantee ("outlives an hour") and the numbers cannot drift apart.
 */
export function redeliveryPolicyCovering(input: {
  minimumSpanMs: number;
  maxBackoffMs: number;
}): RedeliveryPolicy {
  let policy: RedeliveryPolicy = { maxDeliveries: 1, maxBackoffMs: input.maxBackoffMs };
  while (redeliverySpanMs(policy) < input.minimumSpanMs) {
    policy = { ...policy, maxDeliveries: policy.maxDeliveries + 1 };
  }
  return policy;
}

/**
 * The life-safety redelivery budget (V-S1a-3).
 *
 * WHY: a farm alarm or an escalated page was consumed with the bus default —
 * five deliveries, 2/4/8/16 s apart, dead-lettered after ~30 s. An auth-service
 * restart, a database failover or the notification rate-limit window (60 s)
 * each outlast that, so the page was dead-lettered while the outage it was
 * waiting out was still going on.
 *
 * WHAT: capped exponential backoff (steps up to 5 minutes) spanning at least
 * one hour before the message is dead-lettered — where the
 * `event_bus_dead_letter_total` series of a life-safety event type pages the
 * operator (`LifeSafetyAlarmDeadLettered`). The NatsEventBus applies it
 * AUTOMATICALLY to every subscription whose event type the contract marks
 * `requiresLifeSafetyRedelivery`, so no consumer can forget it.
 *
 * The 5-minute step cap is also the ceiling the notification receipt lease
 * must stay under: a crash mid-send leaves a receipt held for one lease, and
 * the next redelivery at the capped step must find it released.
 */
export const LIFE_SAFETY_REDELIVERY: RedeliveryPolicy = redeliveryPolicyCovering({
  minimumSpanMs: 60 * 60 * 1000,
  maxBackoffMs: 5 * 60 * 1000,
});
