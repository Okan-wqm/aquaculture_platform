import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationLog, NotificationStatus } from '../entities/notification-log.entity';

/**
 * Retry Scheduler Service
 *
 * Periodically retries FAILED notification log entries (M2).
 * Runs every 5 minutes and processes failed notifications per tenant using the
 * real resend logic in NotificationDispatcherService.retryFailedNotifications().
 *
 * Only processes records where next_retry_at <= now (exponential backoff).
 */
@Injectable()
export class RetrySchedulerService {
  private readonly logger = new Logger(RetrySchedulerService.name);

  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    @InjectRepository(NotificationLog)
    private readonly logRepository: Repository<NotificationLog>,
  ) {}

  /**
   * Every 5 minutes: find tenants with FAILED notifications due for retry and retry them.
   * Only processes records where next_retry_at is null or has elapsed.
   */
  @Cron('*/5 * * * *', { name: 'notification-retry', timeZone: 'UTC' })
  async retryFailedNotifications(): Promise<void> {
    const now = new Date();

    // Collect distinct tenants that have FAILED notifications due for retry
    const tenantsWithFailures: { tenant_id: string }[] = await this.logRepository
      .createQueryBuilder('log')
      .select('DISTINCT log.tenantId', 'tenant_id')
      .where('log.status = :status', { status: NotificationStatus.FAILED })
      .andWhere('(log.nextRetryAt IS NULL OR log.nextRetryAt <= :now)', { now })
      .getRawMany();

    if (tenantsWithFailures.length === 0) {
      return;
    }

    this.logger.log(
      `Retry scheduler: found ${tenantsWithFailures.length} tenant(s) with failed notifications due for retry`,
    );

    let totalRetried = 0;

    for (const row of tenantsWithFailures) {
      const tenantId = row['tenant_id'];
      try {
        const retried = await this.dispatcher.retryFailedNotifications(tenantId);
        totalRetried += retried;
        if (retried > 0) {
          this.logger.log(`Retried ${retried} notification(s) for tenant ${tenantId.substring(0, 8)}...`);
        }
      } catch (error) {
        this.logger.error(
          `Retry failed for tenant ${tenantId.substring(0, 8)}...: ${(error as Error).message}`,
        );
      }
    }

    if (totalRetried > 0) {
      this.logger.log(`Retry scheduler complete: ${totalRetried} notification(s) retried`);
    }
  }
}
