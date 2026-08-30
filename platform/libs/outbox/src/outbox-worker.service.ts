import * as os from 'os';

import { Injectable, Inject, Logger, OnApplicationBootstrap, Type } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { IEventBus, IEvent } from '@platform/event-bus';
import {
  DataSource,
  EntityManager,
  Repository,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  In,
} from 'typeorm';

import {
  OUTBOX_ENTITY_CLASS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_RETRIES,
  OUTBOX_LAST_ERROR_MAX_LENGTH,
  OUTBOX_LEASE_DURATION_MS,
  OUTBOX_PENDING_AGE_ALARM_MS,
  OUTBOX_PUBLISH_CONCURRENCY,
} from './constants';
import { OutboxEntityBase } from './outbox-entity.base';
import { OutboxMetricsService } from './outbox-metrics.service';
import {
  assertOutboxDeliveryPolicyIntegrity,
  hasSecurityRecoveryDeliveryPolicy,
  OutboxStorageMetadataError,
  withoutOutboxRoutingAttestation,
} from './outbox-routing';
import { assertOutboxTenantIntegrity, OutboxTenantIntegrityError } from './tenant-integrity';

/**
 * OutboxWorkerService
 *
 * Drains the configured outbox table in response to PostgreSQL
 * LISTEN/NOTIFY wake-ups (event-driven, ~5ms median latency) AND a
 * 5-second cron safety net (deterministic backstop for missed
 * notifications or offline listener sessions). Publishes pending
 * events to NATS via `IEventBus.publish()` and marks them as
 * delivered. Dead-letters events after OUTBOX_MAX_RETRIES failed
 * attempts (they remain in the table for forensic inspection but
 * are never re-tried).
 *
 * Why IEventBus and not NestJS ClientProxy:
 *   The shared NatsEventBus uses JetStream with the subject pattern
 *   `events.{tenantId}.{eventType}`. ClientProxy uses core NATS without
 *   tenant routing. Picking IEventBus aligns the outbox-published events
 *   with the same wire format the rest of the platform uses, so the
 *   gateway-api WebSocket bridge can subscribe to a single wildcard.
 *
 * # Concurrency model — row leases via SKIP LOCKED
 *
 * Multiple service replicas each run their own worker. Each cycle
 * claims rows atomically via `FOR UPDATE SKIP LOCKED` inside a brief
 * transaction that only tags the rows (`leasedAt`, `leasedBy`) — the
 * transaction commits BEFORE the NATS publish begins, so the database
 * lock is held for only milliseconds regardless of publish latency.
 *
 * Other replicas scanning the table see the fresh `leasedAt` and skip
 * the row via the polling predicate, without needing a lock. Work
 * shards linearly across replicas: N replicas ≈ N× throughput.
 *
 * If a holder crashes mid-publish, its lease stays fresh for
 * `OUTBOX_LEASE_DURATION_MS` (default 5 minutes). After that window,
 * the next polling worker re-claims the row. At most one duplicate
 * publish can occur per crash, absorbed by NATS
 * `msgID + duplicate_window`.
 *
 * NATS JetStream `duplicate_window` (2 min) is still the final
 * idempotency backstop for any race condition the lease pattern
 * cannot prevent (for example, a re-lease that happens exactly
 * between publish-send and lease-clear).
 *
 * # Bounded publish concurrency
 *
 * Within a single worker cycle, rows are published in parallel with a
 * bounded concurrency of `OUTBOX_PUBLISH_CONCURRENCY` (default 20).
 * This transforms a 500ms serial batch into a ~25ms concurrent batch,
 * unblocking the next poll cycle and reducing p99 latency under burst
 * load. The NATS client multiplexes all 20 publishes over a single
 * TCP connection, so this does not increase connection pressure.
 *
 * # Batched status UPDATE
 *
 * After the publish phase, successful row IDs are committed to
 * `publishedAt = NOW()` via a single `UPDATE ... WHERE id IN (...)`
 * statement instead of N individual updates. A 100-row batch becomes
 * 1 DB round-trip for the success path (from 100).
 *
 * @see Phase 2 checkpoint — C2/P-H1 horizontal-scale fix,
 *      P-H2 throughput fix, P-M2 round-trip consolidation.
 */
@Injectable()
export class OutboxWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private repo!: Repository<OutboxEntityBase>;
  private processing = false;
  /** Prometheus `service` label derived from the consuming entity class name. */
  private readonly metricsLabel: string;
  /**
   * Stable worker identity written to `leasedBy` for debuggability.
   * `${hostname}-${pid}` so operators can correlate a stuck row with
   * the exact pod holding its lease.
   */
  private readonly workerId: string;

  constructor(
    @Inject(OUTBOX_ENTITY_CLASS)
    private readonly entityClass: Type<OutboxEntityBase>,
    private readonly dataSource: DataSource,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    private readonly metrics: OutboxMetricsService,
  ) {
    // `FarmOutbox` → `farm_outbox` — stable, readable, Prometheus-safe.
    this.metricsLabel = entityClass.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

    // Worker identity. Truncated to 128 chars to match the `leasedBy`
    // column constraint — hostname + pid will always fit, but the slice
    // is defensive against exotic container runtimes.
    this.workerId = `${os.hostname()}-${process.pid}`.slice(0, 128);
  }

  async onApplicationBootstrap(): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- LIBRARY-LEVEL outbox worker: the worker drains pending outbox rows ACROSS ALL TENANTS — that is its whole purpose (ADR-006: cross-tenant fan-out worker). Wrapping with tenantManagerRepo would scope the drain to a single tenant context (the worker's own boot context), causing the worker to silently skip every other tenant's queued events. The outbox row itself carries the tenantId field that downstream NATS publishing reads.
    this.repo = this.dataSource.getRepository(this.entityClass);

    if (!this.eventBus.isConnected()) {
      try {
        await this.eventBus.connect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to connect EventBus during outbox worker bootstrap: ${message}`);
        // Do NOT throw — the worker can still poll the DB and the next
        // poll cycle will retry the publish. Throwing here would crash
        // the service if NATS is briefly unavailable at startup.
      }
    }
  }

  /**
   * Polls unpublished outbox events and publishes them to NATS.
   *
   * # Wake-up model
   *
   * This method is invoked from two sources:
   *
   *   1. `OutboxNotifyListener` fires it within ~100ms of every new
   *      outbox row insert, driven by a PostgreSQL `LISTEN` session
   *      on the `${table_name}_notify` channel. This is the primary
   *      real-time path — median enqueue-to-publish latency drops to
   *      ~5ms for events that arrive while the listener is healthy.
   *
   *   2. The 5-second `@Cron` below fires it as a deterministic
   *      safety net. This catches (a) rows that arrived while the
   *      LISTEN session was disconnected (NOTIFY is not delivered
   *      to disconnected clients), (b) failed rows whose lease was
   *      released on a transient publish error, and (c) cold-start
   *      drain before the listener is warmed up.
   *
   * Both paths share the `this.processing` re-entry guard, so a
   * NOTIFY that lands while the cron is mid-cycle (or vice versa)
   * is coalesced into the in-flight cycle — not a separate
   * concurrent drain.
   *
   * # Gauges
   *
   * Every cycle refreshes the Prometheus `outbox_pending` and
   * `outbox_dead_letter_count` gauges — this gives operators a
   * near-real-time view of outbox health without a separate
   * observer job.
   */
  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'outbox-poll' })
  async pollAndPublish(): Promise<void> {
    if (this.processing) return;
    if (!this.repo) return; // bootstrap not yet complete
    this.processing = true;

    try {
      // Refresh gauges IN SYSTEM CONTEXT (ORPHAN-HIGH-321): under tenant
      // RLS these counts read 0, which both lied to Prometheus AND took
      // the `pendingCount === 0` early exit below — the dispatcher never
      // even attempted a lease. Counting is cheap — a partial index on
      // `(createdAt) WHERE publishedAt IS NULL` makes the pending count
      // fast even when the table is large.
      const tableName = this.repo.metadata.tableName;
      const { pendingCount, deadLetterCount, oldestPendingAgeSeconds } =
        await this.runAsOutboxSystem(async (manager) => {
          const [pending, deadLettered] = await Promise.all([
            manager.count(this.entityClass, {
              where: {
                publishedAt: IsNull(),
                retryCount: LessThan(OUTBOX_MAX_RETRIES),
              },
            }),
            manager.count(this.entityClass, {
              where: {
                publishedAt: IsNull(),
                retryCount: MoreThanOrEqual(OUTBOX_MAX_RETRIES),
              },
            }),
          ]);
          const oldestRows: Array<{ age_seconds: string | number | null }> = await manager.query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - MIN("createdAt"))) AS age_seconds
               FROM "${tableName}"
               WHERE "publishedAt" IS NULL AND "isDeadLettered" = false`,
          );
          const rawAge = oldestRows[0]?.age_seconds;
          return {
            pendingCount: pending,
            deadLetterCount: deadLettered,
            oldestPendingAgeSeconds: rawAge == null ? 0 : Number(rawAge),
          };
        });
      this.metrics.setPending(this.metricsLabel, pendingCount);
      this.metrics.setDeadLetterCount(this.metricsLabel, deadLetterCount);
      this.metrics.setOldestPendingAge(this.metricsLabel, oldestPendingAgeSeconds);

      // ORPHAN-HIGH-321: the silent-stall alarm. A healthy dispatcher
      // never lets a row age past the threshold; sustained firing means
      // rows are visible but not draining (NATS down, permissions, ...)
      // — or were invisible until now (the RLS class this cures).
      if (oldestPendingAgeSeconds * 1000 > OUTBOX_PENDING_AGE_ALARM_MS) {
        this.logger.error(
          `Outbox pending-age alarm: oldest unpublished ${this.metricsLabel} row is ` +
            `${Math.round(oldestPendingAgeSeconds)}s old (threshold ` +
            `${OUTBOX_PENDING_AGE_ALARM_MS / 1000}s) — the dispatch pipeline is stalled`,
        );
      }

      if (pendingCount === 0) return;

      // ── Phase 1: Acquire leases ───────────────────────────────────
      // Claim up to OUTBOX_BATCH_SIZE rows by tagging them with
      // (leasedAt, leasedBy) inside a short transaction. The SELECT
      // uses FOR UPDATE SKIP LOCKED so concurrent workers atomically
      // shard the work instead of contending over the same rows.
      const leasedRows = await this.acquireLease();
      if (leasedRows.length === 0) return;

      // ── Phase 2: Publish with bounded concurrency ─────────────────
      // Lease has been committed — the DB lock is released, other
      // workers can pick up subsequent batches in parallel. This phase
      // runs OUTSIDE any transaction so publish latency does not
      // translate into row-lock hold time.
      const { successIds, failures } = await this.publishLeasedBatch(leasedRows);

      // ── Phase 3: Commit outcomes ──────────────────────────────────
      // Batched UPDATE for successes (single round trip) and per-row
      // UPDATE for failures (each carries a distinct error message).
      if (successIds.length > 0) {
        await this.markPublished(successIds);
      }
      for (const failure of failures) {
        await this.markFailed(failure);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Outbox poll cycle failed: ${message}`);
    } finally {
      // The relay completed a cycle - marked in `finally` so a cycle that
      // threw still counts as "the relay is alive", which is the question
      // this gauge answers. A failing relay is a different alarm from an
      // absent one, and conflating them is how a dead dispatcher hides
      // behind an empty queue: outbox_pending stops being written and
      // holds zero, which reads exactly like nothing to do.
      this.metrics.markRelayCycle(this.metricsLabel);
      this.processing = false;
    }
  }

  /**
   * Atomically lease up to `OUTBOX_BATCH_SIZE` pending rows for this
   * worker. The lock is held only for the duration of the SELECT + UPDATE
   * inside the transaction — commit releases it immediately, and the
   * `leasedAt` tag then guards the rows from other workers via the
   * polling predicate.
   *
   * The lease-aware WHERE clause is:
   *   publishedAt IS NULL
   *   AND retryCount < MAX_RETRIES
   *   AND (leasedAt IS NULL OR leasedAt < NOW() - OUTBOX_LEASE_DURATION_MS)
   *
   * The lease expiry window is computed in JavaScript (not in SQL with
   * `NOW() - INTERVAL`) so the query plan remains index-friendly: the
   * partial index `idx_<service>_outbox_poll` already filters on
   * `publishedAt IS NULL`, and the remaining predicate is evaluated
   * row-by-row on the narrowed set.
   */
  /**
   * ORPHAN-HIGH-321 — run outbox table access in SYSTEM context.
   *
   * Every service's outbox table carries the forced `tenant_isolation_policy`
   * (bypass GUC OR tenantId = app.current_tenant). The dispatcher is BY
   * DESIGN a cross-tenant infrastructure sweeper (see the ADR-006 note in
   * onApplicationBootstrap) and polls with NO tenant context — under the
   * policy its SELECT silently saw ZERO rows, its UPDATEs matched nothing,
   * and the transactional-outbox guarantee was void with no error anywhere
   * (2026-07-02: 28 farm rows, newest hours old, zero dispatch attempts).
   *
   * `set_config('app.bypass_rls', 'on', true)` is the same audited system
   * primitive BypassRlsService uses — `is_local = true` scopes it to THIS
   * transaction, so it can never leak through the connection pool. Every
   * table access in this worker MUST go through this helper; a new raw
   * `this.repo.*` call is a regression back to the silent-stall class.
   */
  private async runAsOutboxSystem<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
      return work(manager);
    });
  }

  private async acquireLease(): Promise<OutboxEntityBase[]> {
    const tableName = this.repo.metadata.tableName;
    const leaseCutoff = new Date(Date.now() - OUTBOX_LEASE_DURATION_MS);
    const now = new Date();

    return this.runAsOutboxSystem(async (manager: EntityManager) => {
      // Raw query — TypeORM's QueryBuilder support for SKIP LOCKED with
      // parameterized WHERE clauses has been inconsistent across driver
      // versions. A parameterized raw query is the simplest correct form.
      const rows: OutboxEntityBase[] = await manager.query(
        `SELECT * FROM "${tableName}"
         WHERE "publishedAt" IS NULL
           AND "isDeadLettered" = false
           AND "retryCount" < $1
           AND ("leasedAt" IS NULL OR "leasedAt" < $2)
           AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
         ORDER BY "createdAt" ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
        [OUTBOX_MAX_RETRIES, leaseCutoff, OUTBOX_BATCH_SIZE],
      );

      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.id);

      // Tag the claimed rows. The UPDATE joins the same transaction so
      // the lock remains valid throughout; other workers' SELECTs will
      // skip these rows as soon as the transaction commits.
      await manager.update(
        this.entityClass,
        { id: In(ids) },
        { leasedAt: now, leasedBy: this.workerId },
      );

      // Reflect the new lease state onto the in-memory rows so the
      // caller's logic sees a consistent view without an extra SELECT.
      for (const row of rows) {
        row.leasedAt = now;
        row.leasedBy = this.workerId;
      }

      return rows;
    });
  }

  /**
   * Publish each leased row to NATS with bounded concurrency. Returns
   * arrays of success IDs and failure descriptors — the caller performs
   * the status UPDATEs after all publishes have settled.
   *
   * The concurrency cap is `OUTBOX_PUBLISH_CONCURRENCY`. A single in-flight
   * pool is used (not per-row promises) so memory and event-loop pressure
   * stay bounded even for very large batches.
   */
  private async publishLeasedBatch(rows: OutboxEntityBase[]): Promise<{
    successIds: string[];
    failures: Array<{ row: OutboxEntityBase; error: Error }>;
  }> {
    const successIds: string[] = [];
    const failures: Array<{ row: OutboxEntityBase; error: Error }> = [];

    await runWithConcurrency(rows, OUTBOX_PUBLISH_CONCURRENCY, async (row) => {
      try {
        // The payload was validated at enqueue time
        // (OutboxPublisher.enqueue) and the column is typed IEvent.
        // FARM-HIGH-083: tenant-of-record integrity gate. A tenant-scoped row
        // whose payload tenant is missing / non-UUID / drifted from the column
        // would be silently downgraded onto the cross-tenant events.system.*
        // subject by deriveSubject(). Assert before publishing; a violation
        // throws OutboxTenantIntegrityError, which markFailed dead-letters
        // immediately (the mismatch is permanent — never published).
        assertOutboxTenantIntegrity(row);
        assertOutboxDeliveryPolicyIntegrity(row.payload);
        const event: IEvent = withoutOutboxRoutingAttestation(row.payload);
        await this.eventBus.publish(event);

        successIds.push(row.id);

        // Latency from enqueue (createdAt) to successful publish.
        // Record immediately so the histogram reflects per-event
        // latency even within a batch that has mixed outcomes.
        const publishedAt = Date.now();
        const latencySeconds = (publishedAt - new Date(row.createdAt).getTime()) / 1000;
        this.metrics.recordPublishSuccess(this.metricsLabel, row.eventType, latencySeconds);

        this.logger.debug(
          `Published outbox row ${row.id} (${row.eventType}) to NATS in ${latencySeconds.toFixed(3)}s`,
        );
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        failures.push({ row, error: err });
        this.metrics.recordPublishFailure(this.metricsLabel, row.eventType);
      }
    });

    return { successIds, failures };
  }

  /**
   * Mark a batch of successfully-published rows as published in a single
   * UPDATE. Also clears `leasedAt` / `leasedBy` so the row is visibly
   * terminal in operator tooling — a published row should never appear
   * "leased" to a worker.
   */
  private async markPublished(ids: string[]): Promise<void> {
    const publishedAt = new Date();
    // ORPHAN-HIGH-321: system context — under tenant RLS this UPDATE
    // matched zero rows silently, so a published row would have been
    // re-leased and re-published forever.
    await this.runAsOutboxSystem((manager) =>
      manager.update(
        this.entityClass,
        { id: In(ids) },
        {
          publishedAt,
          leasedAt: null,
          leasedBy: null,
        },
      ),
    );
  }

  /**
   * Record a failed publish attempt on a single row: bump `retryCount`,
   * truncate and persist the error message, and clear the lease so a
   * subsequent poll can re-attempt without waiting for lease expiry.
   *
   * Dead-lettering is implicit — when `retryCount` crosses
   * `OUTBOX_MAX_RETRIES`, the polling predicate stops selecting the row
   * and it drops out of the `outbox_pending` gauge into
   * `outbox_dead_letter_count` automatically.
   */
  private async markFailed(failure: { row: OutboxEntityBase; error: Error }): Promise<void> {
    const { row, error } = failure;
    const securityRecovery = hasSecurityRecoveryDeliveryPolicy(row.payload);
    const attemptedRetryCount = row.retryCount + 1;
    const newRetryCount = securityRecovery
      ? Math.min(attemptedRetryCount, OUTBOX_MAX_RETRIES - 1)
      : attemptedRetryCount;
    const message = error.message;

    // A tenant-integrity violation is PERMANENT — a retry re-reads the same
    // mismatched payload — so dead-letter it immediately instead of consuming the
    // retry budget and re-leasing a row that can never publish (FARM-HIGH-083).
    const permanent =
      error instanceof OutboxTenantIntegrityError || error instanceof OutboxStorageMetadataError;

    if (permanent || (!securityRecovery && newRetryCount >= OUTBOX_MAX_RETRIES)) {
      this.logger.error(
        `Outbox row ${row.id} (${row.eventType}) DEAD-LETTERED ` +
          (permanent
            ? '(tenant-integrity violation, permanent)'
            : `after ${newRetryCount} attempts`) +
          `: ${message}`,
      );
      await this.runAsOutboxSystem((manager) =>
        manager.update(this.entityClass, row.id, {
          retryCount: newRetryCount,
          lastError: message.slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH),
          isDeadLettered: true,
          leasedAt: null,
          leasedBy: null,
        }),
      );
    } else {
      this.logger.warn(
        `Outbox row ${row.id} (${row.eventType}) publish failed (attempt ${newRetryCount}/${OUTBOX_MAX_RETRIES}): ${message}`,
      );
      // Exponential backoff: base 2s * 2^retryCount + random jitter (0-1s).
      // Prevents thundering herd when multiple workers retry simultaneously.
      const retryExponent = Math.min(row.retryCount, OUTBOX_MAX_RETRIES - 1);
      const backoffMs = 2000 * Math.pow(2, retryExponent) + Math.floor(Math.random() * 1000);
      const nextAttemptAt = new Date(Date.now() + backoffMs);
      await this.runAsOutboxSystem((manager) =>
        manager.update(this.entityClass, row.id, {
          retryCount: newRetryCount,
          lastError: message.slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH),
          nextAttemptAt,
          // Release the lease so a subsequent cycle can retry after backoff.
          leasedAt: null,
          leasedBy: null,
        }),
      );
    }
  }

  /**
   * Nightly cleanup at 03:00 — deletes published events older than 7 days.
   * Dead-lettered events (publishedAt = NULL, retryCount >= MAX) are retained.
   */
  @Cron('0 3 * * *', { name: 'outbox-cleanup' })
  async cleanupPublished(): Promise<void> {
    if (!this.repo) return;

    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // ORPHAN-HIGH-321: system context — tenant RLS hid every row from
      // the cleanup DELETE too (published rows would accumulate forever).
      const result = await this.runAsOutboxSystem((manager) =>
        manager.delete(this.entityClass, {
          publishedAt: LessThan(sevenDaysAgo),
        }),
      );

      if (result.affected && result.affected > 0) {
        this.logger.log(`Cleaned up ${result.affected} published outbox events older than 7 days`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Outbox cleanup failed: ${message}`);
    }
  }
}

/**
 * Bounded-concurrency executor.
 *
 * Runs `task(item)` for every item in `items`, keeping at most `limit`
 * invocations in flight at any time. Resolves when every task has
 * settled (success or failure — individual task errors are handled by
 * the caller's task body, this helper never throws).
 *
 * Implementation notes:
 *   - One in-flight set, not per-item promises: bounded memory.
 *   - `Promise.race` is used to await the next slot opening; the
 *     finished promise's `.finally` removes itself from the set.
 *   - Returns `Promise<void>`: all state flows through the task body's
 *     side-effects (caller accumulates results in closed-over arrays).
 *
 * This is a private helper rather than a published utility because the
 * outbox worker is its only consumer inside this library. Promoting it
 * to a shared utility would require test coverage for a range of edge
 * cases (rejected tasks, zero-length input, limit ≥ items.length) that
 * are not relevant to our single in-house call site.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const inFlight = new Set<Promise<void>>();

  for (const item of items) {
    const p = task(item).finally(() => {
      inFlight.delete(p);
    });
    inFlight.add(p);
    if (inFlight.size >= effectiveLimit) {
      // Wait for SOMETHING to finish before starting the next task.
      // Errors inside `task` are caught by the caller's body — this
      // race only cares about settlement, not outcome.
      await Promise.race(inFlight);
    }
  }

  await Promise.all(inFlight);
}
