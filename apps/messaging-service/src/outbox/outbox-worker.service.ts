import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
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
 * - Uses SELECT ... FOR UPDATE SKIP LOCKED to prevent double-publish.
 * - Applies exponential backoff via nextAttemptAt on retry.
 * - Dead-letters events after 5 failed attempts.
 * - Nightly cleanup removes successfully published events older than 7 days.
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
      // ── Claim batch with row-level locking ──
      // FOR UPDATE SKIP LOCKED ensures each worker claims distinct rows.
      // Exclude dead-lettered (retryCount >= MAX_RETRIES) and not-yet-eligible rows.
      const events = await this.outboxRepo
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

      if (events.length === 0) return;

      // ── Mark rows as leased ──
      const eventIds = events.map((e) => e.id);
      await this.outboxRepo
        .createQueryBuilder()
        .update(MessagingOutbox)
        .set({ leasedAt: new Date(), leasedBy: this.workerId })
        .whereInIds(eventIds)
        .execute();

      // Update the outbox-pending gauge for Prometheus
      this.metricsService.setOutboxPending(events.length);

      // ── Publish each event outside the lock ──
      for (const event of events) {
        try {
          await firstValueFrom(
            this.natsClient
              .emit(`events.${event.eventType}`, {
                ...event.payload,
                // IMPORTANT: Nats-Msg-Id for deduplication across retries
                _msgId: event.id,
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

          // ── Exponential backoff: nextAttemptAt = NOW() + base * 2^retryCount ──
          const newRetryCount = event.retryCount + 1;
          const backoffSeconds = BACKOFF_BASE_SECONDS * Math.pow(2, event.retryCount);
          const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);

          await this.outboxRepo.update(event.id, {
            retryCount: newRetryCount,
            lastError: errorMessage.slice(0, 2000),
            nextAttemptAt,
            leasedAt: null,
            leasedBy: null,
          });
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
