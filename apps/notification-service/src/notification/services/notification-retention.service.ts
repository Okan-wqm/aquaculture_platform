import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { NotificationLog, NotificationStatus } from '../entities/notification-log.entity';

/**
 * Notification Retention Service
 *
 * Runs a nightly cleanup job (L3) that deletes SENT and FAILED notification
 * logs older than a configurable retention window.  Without this job the
 * notification_logs table grows unbounded, leading to MVCC bloat and
 * degrading query performance over months of operation.
 *
 * Default retention: 90 days (configurable via NOTIFICATION_LOG_RETENTION_DAYS).
 * Only terminal statuses (SENT, FAILED, BOUNCED) are deleted; PENDING and
 * RETRYING rows are excluded so in-flight notifications are never removed.
 */
@Injectable()
export class NotificationRetentionService {
  private readonly logger = new Logger(NotificationRetentionService.name);
  private readonly retentionDays: number;

  // Statuses that are safe to purge (terminal states only)
  private static readonly PURGEABLE_STATUSES = [
    NotificationStatus.SENT,
    NotificationStatus.FAILED,
    NotificationStatus.BOUNCED,
  ];

  constructor(
    @InjectRepository(NotificationLog)
    private readonly logRepository: Repository<NotificationLog>,
    private readonly configService: ConfigService,
  ) {
    this.retentionDays = this.configService.get<number>('NOTIFICATION_LOG_RETENTION_DAYS', 90);
    this.logger.log(`Notification log retention configured to ${this.retentionDays} days`);
  }

  /**
   * Nightly cleanup at 02:00 UTC.
   * Deletes terminal notification logs older than the retention window.
   */
  @Cron('0 2 * * *', { name: 'notification-log-cleanup', timeZone: 'UTC' })
  async cleanupOldLogs(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);

    this.logger.log(
      `Starting notification log cleanup: removing records older than ${cutoff.toISOString()} ` +
      `(retention: ${this.retentionDays} days)`,
    );

    try {
      const result = await this.logRepository
        .createQueryBuilder()
        .delete()
        .where('status IN (:...statuses)', {
          statuses: NotificationRetentionService.PURGEABLE_STATUSES,
        })
        .andWhere('created_at < :cutoff', { cutoff })
        .execute();

      const deleted = result.affected ?? 0;
      this.logger.log(`Notification log cleanup complete: ${deleted} records deleted`);
    } catch (error) {
      this.logger.error(
        `Notification log cleanup failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
