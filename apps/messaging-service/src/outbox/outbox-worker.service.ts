import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThan } from 'typeorm';
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

/**
 * Outbox worker that polls the `messaging_outbox` table for
 * unpublished events and publishes them to NATS.
 *
 * - Polls every second.
 * - Dead-letters events after 5 failed attempts.
 * - Nightly cleanup removes successfully published events older than 7 days.
 */
@Injectable()
export class OutboxWorkerService implements OnModuleInit {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private processing = false;

  constructor(
    @InjectRepository(MessagingOutbox)
    private readonly outboxRepo: Repository<MessagingOutbox>,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    private readonly metricsService: MessagingMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.natsClient.connect();
  }

  /**
   * Polls unpublished outbox events every second and publishes them to NATS.
   * Skips if a previous cycle is still running.
   */
  @Cron(CronExpression.EVERY_SECOND, { name: 'outbox-poll' })
  async pollAndPublish(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // Exclude dead-lettered events (retryCount >= MAX_RETRIES) from polling.
      // They remain in the DB for inspection but are never re-processed.
      const events = await this.outboxRepo
        .createQueryBuilder('outbox')
        .where('outbox."publishedAt" IS NULL')
        .andWhere('outbox."retryCount" < :maxRetries', { maxRetries: MAX_RETRIES })
        .orderBy('outbox."createdAt"', 'ASC')
        .take(BATCH_SIZE)
        .getMany();

      if (events.length === 0) return;

      // Update the outbox-pending gauge for Prometheus
      this.metricsService.setOutboxPending(events.length);

      for (const event of events) {

        try {
          await firstValueFrom(
            this.natsClient
              .emit(`events.${event.eventType}`, event.payload)
              .pipe(timeout(PUBLISH_TIMEOUT_MS)),
          );

          await this.outboxRepo.update(event.id, {
            publishedAt: new Date(),
          });
        } catch (err) {
          const errorMessage = (err as Error).message;
          this.logger.warn(
            `Failed to publish outbox event ${event.id}: ${errorMessage}`,
          );

          await this.outboxRepo.update(event.id, {
            retryCount: event.retryCount + 1,
            lastError: errorMessage.slice(0, 2000),
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
   * Nightly cleanup at 03:00 — deletes published events older than 7 days.
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
