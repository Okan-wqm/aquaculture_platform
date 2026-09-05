import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotificationLog,
  NotificationStatus,
  NotificationChannel,
} from '../entities/notification-log.entity';

/**
 * Dead Letter Queue read model.
 *
 * The WRITE side lives in the bus: NotificationLogDeadLetterSink records every
 * message the NATS event bus terminates (PLAT-HIGH-902). This service is the
 * read side over the same NotificationLog rows — the admin panel's
 * dead-letter query and the health dashboard's count. The per-handler
 * `handleFailedEvent` ladder (re-publish with a bumped retryCount, persist
 * after MAX_EVENT_RETRIES) is gone: the bus owns redelivery and its budget.
 */
@Injectable()
export class DeadLetterQueueService {
  private readonly logger = new Logger(DeadLetterQueueService.name);

  constructor(
    @InjectRepository(NotificationLog)
    private readonly logRepository: Repository<NotificationLog>,
  ) {}

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
