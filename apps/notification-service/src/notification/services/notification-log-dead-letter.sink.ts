import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { DeadLetterRecord, IDeadLetterSink, IEvent } from '@platform/event-bus';
import { Repository } from 'typeorm';

import {
  NotificationLog,
  NotificationStatus,
  NotificationChannel,
} from '../entities/notification-log.entity';

/**
 * The notification-service dead-letter sink (PLAT-HIGH-902).
 *
 * Bound to the bus through EventBusModule's `deadLetterSink` binding: every
 * message the bus terminates in this service — a handler said `terminate`,
 * or the consumer's delivery budget ran out — lands as a NotificationLog row
 * with status DEAD_LETTER, the same row the admin panel's dead-letter query
 * and the health dashboard's count already read.
 *
 * Stores a redacted summary only. Raw payloads can include PII, tokens,
 * webhook URLs or message content and must not be persisted here; the
 * original event is identified by hash + replay handle.
 */
@Injectable()
export class NotificationLogDeadLetterSink implements IDeadLetterSink {
  private readonly logger = new Logger(NotificationLogDeadLetterSink.name);

  constructor(
    @InjectRepository(NotificationLog)
    private readonly logRepository: Repository<NotificationLog>,
  ) {}

  async record(record: DeadLetterRecord): Promise<void> {
    const { event } = record;
    const tenantId = typeof event.tenantId === 'string' ? event.tenantId : 'unknown';
    const causeMessage =
      record.cause instanceof Error ? (record.cause.stack ?? record.cause.message) : undefined;
    const log = this.logRepository.create({
      tenantId,
      channel: NotificationChannel.SYSTEM,
      recipient: 'dlq',
      subject: `DLQ: ${record.event.eventType}`,
      content: record.reason,
      status: NotificationStatus.DEAD_LETTER,
      errorMessage: causeMessage ?? record.reason,
      retryCount: record.deliveryCount,
      metadata: {
        originalEventHash: hashEvent(event),
        replayHandle: replayHandle(event),
        subject: record.subject,
        disposition: record.disposition,
        deliveryCount: record.deliveryCount,
        maxDeliver: record.maxDeliver,
        failedAt: record.terminatedAt,
        eventType: record.event.eventType,
        eventId: record.event.eventId,
        tenantId,
      },
    });
    await this.logRepository.save(log);
    this.logger.error(
      `DLQ entry saved for ${record.event.eventType} (${record.disposition}, tenant: ${tenantId.substring(0, 8)}...)`,
    );
  }
}

function hashEvent(event: IEvent): string {
  return createHash('sha256')
    .update(JSON.stringify(event, Object.keys(event).sort()))
    .digest('hex');
}

function replayHandle(event: IEvent): string {
  const tenantId = typeof event.tenantId === 'string' ? event.tenantId : 'unknown';
  return `${event.eventType}:${tenantId}:${event.eventId}`;
}
