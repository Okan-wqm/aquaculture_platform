/**
 * OutboxMetricsService
 *
 * Prometheus metrics for the transactional outbox. Registered in the
 * default prom-client registry so the consuming service's existing
 * `/metrics` endpoint exposes them automatically — no extra wiring
 * required in the HTTP layer.
 *
 * # Metric design
 *
 * All metrics carry a `service` label so multiple services using the
 * shared library can coexist in the same Prometheus scrape:
 *   - `outbox_pending{service}` — gauge, number of unpublished rows
 *   - `outbox_dead_letter_count{service}` — gauge, rows that exceeded
 *     OUTBOX_MAX_RETRIES and were dead-lettered
 *   - `outbox_publish_latency_seconds{service}` — histogram, time from
 *     `createdAt` (when the handler enqueued the event) to `publishedAt`
 *     (when the worker successfully published to NATS). A sustained
 *     p99 above ~5 seconds indicates the worker is falling behind.
 *   - `outbox_publish_total{service, event_type}` — counter, successful
 *     publishes labelled by event type for per-type health insight
 *   - `outbox_publish_failures_total{service, event_type}` — counter,
 *     failed publish attempts (retries count here, not just dead letters)
 *
 * # Double-registration safety
 *
 * prom-client throws if two services register a metric with the same
 * name at module init. Because Nest can instantiate modules multiple
 * times in tests and because the library may be imported into services
 * that share a process, each metric is looked up via `registry.getSingleMetric`
 * before creation. The singleton metric is shared across every
 * OutboxMetricsService instance in the process.
 *
 * @see Phase E of farm domain real-time visibility plan.
 */

import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';

const METRIC_PENDING = 'outbox_pending';
const METRIC_OLDEST_PENDING_AGE = 'outbox_oldest_pending_age_seconds';
const METRIC_DEAD_LETTER = 'outbox_dead_letter_count';
const METRIC_PUBLISH_LATENCY = 'outbox_publish_latency_seconds';
const METRIC_PUBLISH_TOTAL = 'outbox_publish_total';
const METRIC_PUBLISH_FAILURES = 'outbox_publish_failures_total';
const METRIC_RELAY_LAST_CYCLE = 'outbox_relay_last_cycle_timestamp_seconds';

/**
 * Histogram buckets cover the expected distribution:
 *   - 0.01s (outbox worker polls every 1s, fast path when publish succeeds)
 *   - up through 60s (worst-case NATS reconnect + retry)
 */
const LATENCY_BUCKETS = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const;

@Injectable()
export class OutboxMetricsService {
  private readonly pending: client.Gauge<string>;
  private readonly oldestPendingAge: client.Gauge<string>;
  private readonly deadLetterCount: client.Gauge<string>;
  private readonly publishLatency: client.Histogram<string>;
  private readonly publishTotal: client.Counter<string>;
  private readonly publishFailures: client.Counter<string>;
  private readonly relayLastCycle: client.Gauge<string>;

  constructor() {
    const registry = client.register;

    this.pending =
      (registry.getSingleMetric(METRIC_PENDING) as client.Gauge<string>) ??
      new client.Gauge({
        name: METRIC_PENDING,
        help: 'Number of unpublished outbox events pending worker pickup',
        labelNames: ['service'],
        registers: [registry],
      });

    this.deadLetterCount =
      (registry.getSingleMetric(METRIC_DEAD_LETTER) as client.Gauge<string>) ??
      new client.Gauge({
        name: METRIC_DEAD_LETTER,
        help: 'Number of outbox events that exceeded OUTBOX_MAX_RETRIES',
        labelNames: ['service'],
        registers: [registry],
      });

    this.publishLatency =
      (registry.getSingleMetric(
        METRIC_PUBLISH_LATENCY,
      ) as client.Histogram<string>) ??
      new client.Histogram({
        name: METRIC_PUBLISH_LATENCY,
        help: 'Latency from outbox enqueue to successful NATS publish (seconds)',
        labelNames: ['service'],
        buckets: [...LATENCY_BUCKETS],
        registers: [registry],
      });

    this.oldestPendingAge =
      (registry.getSingleMetric(
        METRIC_OLDEST_PENDING_AGE,
      ) as client.Gauge<string>) ??
      new client.Gauge({
        name: METRIC_OLDEST_PENDING_AGE,
        help: 'Age in seconds of the oldest unpublished (non-dead-lettered) outbox row — alert on sustained growth (ORPHAN-HIGH-321)',
        labelNames: ['service'],
        registers: [registry],
      });

    this.publishTotal =
      (registry.getSingleMetric(
        METRIC_PUBLISH_TOTAL,
      ) as client.Counter<string>) ??
      new client.Counter({
        name: METRIC_PUBLISH_TOTAL,
        help: 'Total number of outbox events successfully published to NATS',
        labelNames: ['service', 'event_type'],
        registers: [registry],
      });

    this.publishFailures =
      (registry.getSingleMetric(
        METRIC_PUBLISH_FAILURES,
      ) as client.Counter<string>) ??
      new client.Counter({
        name: METRIC_PUBLISH_FAILURES,
        help: 'Total number of outbox publish failures (includes retries)',
        labelNames: ['service', 'event_type'],
        registers: [registry],
      });

    this.relayLastCycle =
      (registry.getSingleMetric(METRIC_RELAY_LAST_CYCLE) as client.Gauge<string>) ??
      new client.Gauge({
        name: METRIC_RELAY_LAST_CYCLE,
        help: 'Unix timestamp of the last completed outbox relay cycle (liveness, not throughput)',
        labelNames: ['service'],
        registers: [registry],
      });
  }

  /**
   * The relay completed a cycle.
   *
   * WHY a separate signal from the pending gauges: `outbox_pending` and
   * `outbox_oldest_pending_age_seconds` describe the QUEUE. If the relay
   * process stops, those gauges stop being written and hold their last
   * value - a stalled dispatcher with an empty queue reports zero pending
   * forever and looks perfectly healthy. This gauge describes the RELAY,
   * so "nothing to publish" and "nothing is publishing" stop being the
   * same observation.
   *
   * Set on every cycle including the ones that found nothing: an idle
   * relay is alive, and that is exactly the case the queue gauges cannot
   * distinguish from a dead one.
   */
  markRelayCycle(service: string): void {
    this.relayLastCycle.set({ service }, Date.now() / 1000);
  }

  /** Update the pending-count gauge for this service. */
  setPending(service: string, count: number): void {
    this.pending.set({ service }, count);
  }

  /**
   * ORPHAN-HIGH-321: age (seconds) of the OLDEST unpublished, non-dead-
   * lettered row. The one signal that exposes a silently-stalled
   * dispatcher — alert when it exceeds the OUTBOX_PENDING_AGE_ALARM_MS
   * threshold. 0 when the queue is empty.
   */
  setOldestPendingAge(service: string, seconds: number): void {
    this.oldestPendingAge.set({ service }, seconds);
  }

  /** Update the dead-letter-count gauge for this service. */
  setDeadLetterCount(service: string, count: number): void {
    this.deadLetterCount.set({ service }, count);
  }

  /**
   * Record a successful publish: increments the success counter and
   * observes the end-to-end latency (enqueue → NATS ack).
   */
  recordPublishSuccess(
    service: string,
    eventType: string,
    latencySeconds: number,
  ): void {
    this.publishTotal.inc({ service, event_type: eventType }, 1);
    this.publishLatency.observe({ service }, latencySeconds);
  }

  /** Record a failed publish attempt (retries counted separately from dead letters). */
  recordPublishFailure(service: string, eventType: string): void {
    this.publishFailures.inc({ service, event_type: eventType }, 1);
  }
}
