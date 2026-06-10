import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotificationLog,
  NotificationStatus,
  NotificationChannel,
} from '../entities/notification-log.entity';

/**
 * Maximum retry attempts before an event is moved to the dead letter queue.
 */
const MAX_EVENT_RETRIES = 3;

/**
 * Dead Letter Queue Service
 *
 * Provides a centralized DLQ mechanism for event handlers.
 * When an event handler fails repeatedly, the event payload is persisted
 * to NotificationLog with status=DEAD_LETTER so it can be investigated
 * and replayed later.
 *
 * Usage pattern (in event handlers):
 * ```
 * try {
 *   await this.processEvent(event);
 * } catch (error) {
 *   await this.dlqService.handleFailedEvent(event, error);
 * }
 * ```
 */
@Injectable()
export class DeadLetterQueueService {
  private readonly logger = new Logger(DeadLetterQueueService.name);

  constructor(
    @InjectRepository(NotificationLog)
    private readonly logRepository: Repository<NotificationLog>,
  ) {}

  /**
   * Handle a failed event.
   *
   * If the event has been retried fewer than MAX_EVENT_RETRIES times, it
   * returns `{ retry: true, retryCount }` so the caller can re-publish with
   * an incremented retryCount and a fresh eventId (to bypass NATS dedup window).
   *
   * If retries are exhausted the event is persisted to the DLQ and
   * `{ retry: false }` is returned.
   */
  async handleFailedEvent(
    event: Record<string, unknown>,
    error: unknown,
  ): Promise<{ retry: boolean; retryCount: number }> {
    const eventType = String(event['eventType'] || 'unknown');
    const eventId = String(event['eventId'] || 'unknown');
    const retryCount = (Number(event['retryCount']) || 0) + 1;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    if (retryCount <= MAX_EVENT_RETRIES) {
      this.logger.warn(
        `Event ${eventType} (${eventId.substring(0, 8)}...) ` +
        `failed, attempt ${retryCount}/${MAX_EVENT_RETRIES}: ${errorMessage}`,
      );
      return { retry: true, retryCount };
    }

    // Retries exhausted -- persist to DLQ
    this.logger.error(
      `DLQ: Event ${eventType} (${eventId.substring(0, 8)}...) ` +
      `failed after ${retryCount} attempts. Persisting to dead letter queue.`,
    );

    await this.saveToDLQ(event, errorMessage, errorStack);
    return { retry: false, retryCount };
  }

  /**
   * Persist a dead-lettered event to NotificationLog.
   *
   * Stores a redacted summary only. Raw payloads can include PII, tokens,
   * webhook URLs, or message content and must not be persisted in DLQ.
   */
  private async saveToDLQ(
    event: Record<string, unknown>,
    errorMessage: string,
    errorStack?: string,
  ): Promise<void> {
    try {
      const log = this.logRepository.create({
        tenantId: (event.tenantId as string) || 'unknown',
        channel: NotificationChannel.SYSTEM,
        recipient: 'dlq',
        subject: `DLQ: ${event.eventType}`,
        content: errorMessage,
        status: NotificationStatus.DEAD_LETTER,
        errorMessage: errorStack || errorMessage,
        retryCount: (event.retryCount as number) || 0,
        metadata: {
          originalEventHash: this.hashEvent(event),
          replayHandle: this.replayHandle(event),
          failedAt: new Date().toISOString(),
          eventType: event.eventType,
          eventId: event.eventId,
          tenantId: event.tenantId,
        },
      });

      await this.logRepository.save(log);

      this.logger.log(
        `DLQ entry saved for event ${event.eventType} ` +
        `(tenant: ${((event.tenantId as string) || 'unknown').substring(0, 8)}...)`,
      );
    } catch (dbError) {
      this.logger.error(
        `CRITICAL: Failed to persist DLQ entry for event ${event.eventType}. ` +
        `DB error: ${(dbError as Error).message}. ` +
        `Original error: ${errorMessage}. ` +
        `eventHash=${this.hashEvent(event)} replayHandle=${this.replayHandle(event)}`,
      );
    }
  }

  private hashEvent(event: Record<string, unknown>): string {
    return createHash('sha256')
      .update(JSON.stringify(event, Object.keys(event).sort()))
      .digest('hex');
  }

  private replayHandle(event: Record<string, unknown>): string {
    const eventType = typeof event.eventType === 'string' ? event.eventType : 'unknown';
    const eventId = typeof event.eventId === 'string' ? event.eventId : 'unknown';
    const tenantId = typeof event.tenantId === 'string' ? event.tenantId : 'unknown';
    return `${eventType}:${tenantId}:${eventId}`;
  }

  /**
   * Query dead-lettered events for a tenant (for admin panel / replay tooling).
   */
  async getDeadLetterEvents(
    tenantId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ items: NotificationLog[]; total: number }> {
    const [items, total] = await this.logRepository.findAndCount({
      where: {
        tenantId,
        status: NotificationStatus.DEAD_LETTER,
      },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { items, total };
  }

  /**
   * Count dead-lettered events across all tenants (for health dashboard).
   */
  async countAll(): Promise<number> {
    return this.logRepository.count({
      where: { status: NotificationStatus.DEAD_LETTER },
    });
  }
}
