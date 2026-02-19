import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import { NotificationLog } from './entities/notification-log.entity';

// Services
import { EmailService } from './services/email.service';
import { SmsService } from './services/sms.service';
import { PushService } from './services/push.service';
import { NotificationDispatcherService } from './services/notification-dispatcher.service';
import { NotificationRetentionService } from './services/notification-retention.service';
import { RetrySchedulerService } from './services/retry-scheduler.service';

// Event Handlers
import { AlertTriggeredEventHandler } from './event-handlers/alert-triggered.handler';

/**
 * Notification Module
 * Contains all notification-related functionality including:
 * - Multi-channel notification dispatch (Email, SMS, Push, Webhook)
 * - Notification logging and tracking
 * - Retry mechanism for failed notifications (scheduled every 5 minutes)
 * - Nightly log retention cleanup (removes logs older than retention window)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([NotificationLog]),
    // Required for @Cron decorators in RetrySchedulerService and NotificationRetentionService
    ScheduleModule.forRoot(),
  ],
  providers: [
    // Services
    EmailService,
    SmsService,
    PushService,
    NotificationDispatcherService,

    // Scheduled jobs
    NotificationRetentionService,
    RetrySchedulerService,

    // Event Handlers
    AlertTriggeredEventHandler,
  ],
  exports: [NotificationDispatcherService, EmailService, SmsService, PushService],
})
export class NotificationModule {}
