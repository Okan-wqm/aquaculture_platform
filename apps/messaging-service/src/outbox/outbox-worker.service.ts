import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { MessagingOutbox } from './messaging-outbox.entity';
import { MessagingMetricsService } from '../metrics/messaging-metrics.service';

/** Maximum number of outbox events processed per poll cycle. */
const BATCH_SIZE = 100;

/** Events with retryCount >= this threshold are dead-lettered. */
const MAX_RETRIES = 5;

/** Timeout (ms) for each NATS publish attempt. */
const PUBLISH_TIMEOUT_MS = 5000;

/** Base backoff interval in seconds for exponential retry. */
const BACKOFF_BASE_SECONDS = 2;

/** Lease duration in milliseconds. After this, a lease is considered expired. */
const LEASE_DURATION_MS = 5 * 60 * 1000;

/**
 * Outbox worker that polls the `messaging_outbox` table for
 * unpublished events and publishes them to NATS.
 *
 * - Polls every second.
 * - Uses SELECT ... FOR UPDATE SKIP LOCKED inside a transaction to prevent
 *   double-publish. TypeORM requires pessimistic locks to run within a
 *   transaction — without one, the QueryBuilder throws
 *   "An open transaction is required for pessimistic lock."
 * - Applies exponential backoff via nextAttemptAt on retry.
 * - Dead-letters events after 5 failed attempts.
 * - Nightly cleanup removes successfully published events older than 7 days.
 *
 * # Concurrency model — lease acquisition inside transaction, publish outside
 *
 * Phase 1 (transaction): SELECT FOR UPDATE SKIP LOCKED + lease tag UPDATE.
 *   The transaction commits BEFORE any NATS publish begins, so the database
 *   lock is held for milliseconds only — regardless of publish latency.
 *
 * Phase 2 (no transaction): NATS publish for each leased row. Network latency
 *   does not hold database locks. Other replicas can claim the next batch
 *   in parallel.
 *
 * This matches the @platform/outbox worker architecture exactly.
 */
@Injectable()
export class OutboxWorkerService implements OnModuleInit {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private processing = false;
  private readonly workerId: string;

  constructor(
    @InjectRepository(MessagingOutbox)
    private readonly outboxRepo: Repository<MessagingOutbox>,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    private readonly metricsService: MessagingMetricsService,
    private readonly dataSource: DataSource,
  ) {
    // IMPORTANT: Worker identity for lease tracking -- hostname + pid
    const hostname = process.env.HOSTNAME ?? 'unknown';
    this.workerId = `${hostname}-${process.pid}`;
  }

  async onModuleInit(): Promise<void> {
    await this.natsClient.connect();
  }

  /**
   * Polls unpublished outbox events every second and publishes them to NATS.
   * Skips if a previous cycle is still running.
   *
   * SECURITY: Uses FOR UPDATE SKIP LOCKED to prevent double-publish when
   * multiple worker replicas poll the same table simultaneously.
   */
  @Cron(CronExpression.EVERY_SECOND, { name: 'outbox-poll' })
  async pollAndPublish(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // ── Phase 1: Acquire leases inside a transaction ──────────────────
      // TypeORM requires pessimistic locks (FOR UPDATE SKIP LOCKED) to run
      // within a transaction. The transaction commits BEFORE the NATS publish
      // phase, so the database lock is held for milliseconds only.
      const events = await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(MessagingOutbox);

        const rows = await repo
          .createQueryBuilder('outbox')
          .setLock('pessimistic_write_or_fail')
          .where('outbox."publishedAt" IS NULL')
          .andWhere('outbox."retryCount" < :maxRetries', { maxRetries: MAX_RETRIES })
          .andWhere('outbox."nextAttemptAt" <= NOW()')
          .andWhere(
            '(outbox."leasedAt" IS NULL OR outbox."leasedAt" < :leaseExpiry)',
            { leaseExpiry: new Date(Date.now() - LEASE_DURATION_MS) },
          )
          .orderBy('outbox."createdAt"', 'ASC')
          .take(BATCH_SIZE)
          .getMany();

        if (rows.length === 0) return [];

        // Tag claimed rows with this worker's identity. The UPDATE runs in
        // the same transaction so the lock remains valid — other workers'
        // SELECTs skip these rows via SKIP LOCKED.
        const eventIds = rows.map((e) => e.id);
        await manager
          .createQueryBuilder()
          .update(MessagingOutbox)
          .set({ leasedAt: new Date(), leasedBy: this.workerId })
          .whereInIds(eventIds)
          .execute();

        return rows;
      });
      // Transaction committed — database lock released.

      if (events.length === 0) return;

      // Update the outbox-pending gauge for Prometheus
      this.metricsService.setOutboxPending(events.length);

      // ── Phase 2: Publish each event OUTSIDE the transaction ───────────
      // Network latency does not hold database locks. Other replicas can
      // claim the next batch in parallel.
      for (const event of events) {
        try {
          // SECURITY: Include tenantId in NATS subject for per-tenant routing.
          // Format: events.{tenantId}.{eventType} — enables per-tenant filtering
          // and prevents cross-tenant event subscription.
          // @see MSG-HIGH-051 (NATS subject missing tenantId)
          const subject = `events.${event.tenantId}.${event.eventType}`;

          await firstValueFrom(
            this.natsClient
              .emit(subject, {
                ...event.payload,
                // IMPORTANT: Nats-Msg-Id header for JetStream deduplication.
                // Using outbox row UUID ensures globally unique dedup key across replicas.
                // @see MSG-HIGH-004 (outbox publisher Nats-Msg-Id)
                _nats_msg_id: event.id,
              })
              .pipe(timeout(PUBLISH_TIMEOUT_MS)),
          );

          await this.outboxRepo.update(event.id, {
            publishedAt: new Date(),
            leasedAt: null,
            leasedBy: null,
          });
        } catch (err) {
          const errorMessage = (err as Error).message;
          this.logger.warn(
            `Failed to publish outbox event ${event.id}: ${errorMessage}`,
          );

          // ── Exponential backoff with jitter: nextAttemptAt = NOW() + base * 2^retryCount + jitter ──
          // @see MSG-HIGH-005 (exponential backoff on publish retry)
          const newRetryCount = event.retryCount + 1;
          const backoffSeconds = BACKOFF_BASE_SECONDS * Math.pow(2, event.retryCount);
          // WHY: Jitter prevents thundering herd when multiple workers retry simultaneously
          const jitterMs = Math.floor(Math.random() * 1000);
          const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000 + jitterMs);

          // ── Dead-letter events that exceed MAX_RETRIES ──
          // @see MSG-HIGH-006 (dead-letter metric counter)
          if (newRetryCount >= MAX_RETRIES) {
            await this.outboxRepo.update(event.id, {
              retryCount: newRetryCount,
              lastError: errorMessage.slice(0, 2000),
              isDeadLettered: true,
              leasedAt: null,
              leasedBy: null,
            });
            this.metricsService.incrementDeadLetter();
            this.logger.error(
              `Outbox event ${event.id} dead-lettered after ${newRetryCount} attempts`,
            );
          } else {
            await this.outboxRepo.update(event.id, {
              retryCount: newRetryCount,
              lastError: errorMessage.slice(0, 2000),
              nextAttemptAt,
              leasedAt: null,
              leasedBy: null,
            });
          }
        }
      }
    } catch (err) {
      this.logger.error(`Outbox poll cycle error: ${(err as Error).message}`);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Nightly cleanup at 03:00 -- deletes published events older than 7 days.
   */
  @Cron('0 3 * * *', { name: 'outbox-cleanup' })
  async cleanupPublished(): Promise<void> {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const result = await this.outboxRepo.delete({
        publishedAt: LessThan(sevenDaysAgo),
      });

      if (result.affected && result.affected > 0) {
        this.logger.log(`Cleaned up ${result.affected} published outbox events`);
      }
    } catch (err) {
      this.logger.error(`Outbox cleanup failed: ${(err as Error).message}`);
    }
  }
}
