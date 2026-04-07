import {
  Injectable,
  Inject,
  Logger,
  OnApplicationBootstrap,
  Type,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, Repository, IsNull, LessThan } from 'typeorm';
import type { IEventBus, IEvent } from '@platform/event-bus';
import { OutboxEntityBase } from './outbox-entity.base';
import {
  OUTBOX_ENTITY_CLASS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_RETRIES,
  OUTBOX_LAST_ERROR_MAX_LENGTH,
} from './constants';

/**
 * OutboxWorkerService
 *
 * Polls the configured outbox table once per second, publishes pending
 * events to NATS via `IEventBus.publish()`, and marks them as delivered.
 * Dead-letters events after OUTBOX_MAX_RETRIES failed attempts (they
 * remain in the table for forensic inspection but are never re-tried).
 *
 * Why IEventBus and not NestJS ClientProxy:
 *   The shared NatsEventBus uses JetStream with the subject pattern
 *   `events.{tenantId}.{eventType}`. ClientProxy uses core NATS without
 *   tenant routing. Picking IEventBus aligns the outbox-published events
 *   with the same wire format the rest of the platform uses, so the
 *   gateway-api WebSocket bridge can subscribe to a single wildcard.
 *
 * Concurrency model:
 *   Multiple service replicas each run their own worker. NATS JetStream
 *   `duplicate_window` (2 min) handles dedup via `eventId` so concurrent
 *   workers publishing the same row are idempotent at the broker level.
 *   The DB UPDATE on `publishedAt` is single-row and atomic; the second
 *   replica's UPDATE simply overwrites with the same `publishedAt` value.
 *
 * @see Phase 2 of farm domain real-time visibility plan.
 */
@Injectable()
export class OutboxWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private repo!: Repository<OutboxEntityBase>;
  private processing = false;

  constructor(
    @Inject(OUTBOX_ENTITY_CLASS)
    private readonly entityClass: Type<OutboxEntityBase>,
    private readonly dataSource: DataSource,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.repo = this.dataSource.getRepository(this.entityClass);

    if (!this.eventBus.isConnected()) {
      try {
        await this.eventBus.connect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to connect EventBus during outbox worker bootstrap: ${message}`,
        );
        // Do NOT throw — the worker can still poll the DB and the next
        // poll cycle will retry the publish. Throwing here would crash
        // the service if NATS is briefly unavailable at startup.
      }
    }
  }

  /**
   * Polls unpublished outbox events every second and publishes them to NATS.
   * Skips silently if a previous cycle is still running (no overlap).
   */
  @Cron(CronExpression.EVERY_SECOND, { name: 'outbox-poll' })
  async pollAndPublish(): Promise<void> {
    if (this.processing) return;
    if (!this.repo) return; // bootstrap not yet complete
    this.processing = true;

    try {
      const events = await this.repo.find({
        where: {
          publishedAt: IsNull(),
          retryCount: LessThan(OUTBOX_MAX_RETRIES),
        },
        order: { createdAt: 'ASC' },
        take: OUTBOX_BATCH_SIZE,
      });

      if (events.length === 0) return;

      for (const row of events) {
        await this.publishOne(row);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Outbox poll cycle failed: ${message}`);
    } finally {
      this.processing = false;
    }
  }

  private async publishOne(row: OutboxEntityBase): Promise<void> {
    try {
      // Reconstruct the IEvent from the JSONB payload. The cast is safe
      // because OutboxPublisher only enqueues full BaseEvent objects.
      const event = row.payload as unknown as IEvent;
      await this.eventBus.publish(event);

      await this.repo.update(row.id, { publishedAt: new Date() });

      this.logger.debug(
        `Published outbox row ${row.id} (${row.eventType}) to NATS`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const newRetryCount = row.retryCount + 1;

      if (newRetryCount >= OUTBOX_MAX_RETRIES) {
        this.logger.error(
          `Outbox row ${row.id} (${row.eventType}) DEAD-LETTERED after ${newRetryCount} attempts: ${message}`,
        );
      } else {
        this.logger.warn(
          `Outbox row ${row.id} (${row.eventType}) publish failed (attempt ${newRetryCount}/${OUTBOX_MAX_RETRIES}): ${message}`,
        );
      }

      await this.repo.update(row.id, {
        retryCount: newRetryCount,
        lastError: message.slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH),
      });
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

      const result = await this.repo.delete({
        publishedAt: LessThan(sevenDaysAgo),
      });

      if (result.affected && result.affected > 0) {
        this.logger.log(
          `Cleaned up ${result.affected} published outbox events older than 7 days`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Outbox cleanup failed: ${message}`);
    }
  }
}
