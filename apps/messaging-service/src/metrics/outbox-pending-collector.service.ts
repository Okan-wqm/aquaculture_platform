/**
 * @module OutboxPendingCollectorService
 * @description MSGFIX-FAZ0 (2026-09-16) observability gap: the domain gauge
 * `messaging_outbox_pending` (owned by MessagingMetricsService and served on
 * the single /metrics scrape endpoint) was registered but NEVER written — no
 * code path called `setOutboxPending()`. Meanwhile the shared outbox worker
 * refreshes its own `outbox_pending{service}` gauge, but that one lives in the
 * GLOBAL prom-client default registry, which the platform ServiceMetrics
 * scrape endpoint does NOT serve for this service. Result: the queue depth of
 * the messaging transactional outbox was invisible to Prometheus.
 *
 * This collector counts pending (unpublished) rows in
 * `messaging.messaging_outbox` every 30 seconds and writes the existing
 * `messaging_outbox_pending` gauge.
 *
 * # Schema scope — source-only, no tenant traversal
 *
 * `messaging_outbox` is SOURCE-ONLY infrastructure: migration
 * 1800200000000-CreateMessagingOutboxTable pins search_path to 'messaging'
 * and its postCondition FAILS if any `tenant_*` schema holds a copy;
 * 1800400000000-EnforceSourceOnlyMessagingOutboxContract enforces the same
 * contract. The outbox worker likewise operates on a single repository bound
 * to schema 'messaging' (cross-tenant by design — the tenantId is a column,
 * not a schema). Counting the one source table therefore measures the ENTIRE
 * platform backlog; there is nothing cheaper or more correct to traverse.
 *
 * # Pending semantics
 *
 * "Pending" = `"publishedAt" IS NULL AND "isDeadLettered" = false` — rows the
 * dispatcher still owes a publish. This intentionally EXCLUDES dead-lettered
 * rows (they are terminal). Note the platform worker's internal
 * `outbox_pending{service}` gauge uses `retryCount < OUTBOX_MAX_RETRIES`
 * instead, which keeps permanently dead-lettered tenant-integrity rows in its
 * count; the domain gauge documented here is the dispatchable-backlog view.
 *
 * # RLS safety
 *
 * The count runs inside a transaction with
 * `set_config('app.bypass_rls', 'on', true)` — the same audited system
 * primitive the outbox worker uses (ORPHAN-HIGH-321). messaging_outbox is on
 * the RLS exclude list for this service, so today the flag is a no-op; it
 * keeps the gauge honest if the forced-policy set ever drifts back onto this
 * table (under RLS the count would silently read 0 — the exact lie that hid
 * the 2026-07-02 farm stall).
 */
import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { MessagingMetricsService } from './messaging-metrics.service';

/** Count of pending rows returned by the collector query. */
interface PendingCountRow {
  pending: number | string | null;
}

@Injectable()
export class OutboxPendingCollectorService implements OnModuleInit {
  private readonly logger = new Logger(OutboxPendingCollectorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MessagingMetricsService,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  /** Seed the gauge at startup instead of waiting up to 30s for the first tick. */
  onModuleInit(): void {
    // Fire-and-forget: a cold DB must never block module init; the cron tick
    // will retry and the gauge simply stays absent until one succeeds.
    void this.collectPendingCount();
  }

  /**
   * Every 30 seconds, count unpublished non-dead-lettered outbox rows and
   * expose them as `messaging_outbox_pending`.
   *
   * The query is cheap: the partial index `idx_outbox_poll`
   * (`"createdAt" WHERE "publishedAt" IS NULL AND "isDeadLettered" = false`)
   * exists precisely for this predicate shape.
   *
   * `each-replica` (ADMIN-HIGH-013): the gauge lives in this process's
   * registry and each replica serves its own scrape, so every replica must
   * tick — the governed schedule keeps the heartbeat and skips the lease.
   */
  @ScheduledJob({
    name: 'messaging-outbox.pending-collector',
    every: 30_000,
    scope: 'each-replica',
  })
  async collectPendingCount(): Promise<void> {
    try {
      const pending = await this.countPendingRows();
      this.metrics.setOutboxPending(pending);
    } catch (error) {
      // A scrapeable metric must never crash the scheduler loop. A transient
      // DB error leaves the gauge at its last value; the pending-age alarm
      // on the worker side covers a stuck queue.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Outbox pending count failed: ${message}`);
    }
  }

  private async countPendingRows(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      // ORPHAN-HIGH-321 pattern: transaction-local system context. is_local=true
      // scopes the GUC to this transaction — it cannot leak through the pool.
      await manager.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const rows: PendingCountRow[] = await manager.query(
        `SELECT count(*)::int AS pending
           FROM messaging.messaging_outbox
          WHERE "publishedAt" IS NULL
            AND "isDeadLettered" = false`,
      );
      const raw = rows[0]?.pending ?? 0;
      return Number(raw);
    });
  }
}
