import { AiSafetyCoreModule } from '@aquaculture/backend-common/ai-safety';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeviceToken } from './entities/device-token.entity';
import { NotificationLog } from './entities/notification-log.entity';
import { AlertTriggeredEventHandler } from './event-handlers/alert-triggered.handler';
import { AuthEventHandler } from './event-handlers/auth-event.handler';
import { BillingEventHandler } from './event-handlers/billing-event.handler';
import { DeviceTokenRevocationHandler } from './event-handlers/device-token-revocation.handler';
import { FeedingDailySummaryEventHandler } from './event-handlers/feeding-daily-summary.handler';
import { HarvestRegulatoryRecordedEventHandler } from './event-handlers/harvest-regulatory.handler';
import { MessagingEventHandler } from './event-handlers/messaging-event.handler';
import { NotificationCommandHandler } from './event-handlers/notification-command.handler';
import { RegulatoryReportEventHandler } from './event-handlers/regulatory-report.handler';
import { TaskEventHandler } from './event-handlers/task-event.handler';
import { NotificationResolver } from './resolvers/notification.resolver';
import { DeadLetterQueueService } from './services/dead-letter-queue.service';
import { EmailService } from './services/email.service';
import { InAppNotificationService } from './services/in-app.service';
import { NotificationDispatcherService } from './services/notification-dispatcher.service';
import { NotificationRetentionService } from './services/notification-retention.service';
import { PushService } from './services/push.service';
import { RetrySchedulerService } from './services/retry-scheduler.service';
import { SmsService } from './services/sms.service';

/**
 * Notification Module
 * Contains all notification-related functionality including:
 * - Multi-channel notification dispatch (Email, SMS, Push, Webhook, In-App)
 * - Notification logging and tracking
 * - Retry mechanism for failed notifications (scheduled every 5 minutes)
 * - Nightly log retention cleanup (removes logs older than retention window)
 * - In-app notification queries and mutations via GraphQL
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([NotificationLog, DeviceToken]),
    // Required for @Cron decorators — forRoot() is in AppModule, plain import here
    ScheduleModule,
    // SSRF validator (+ unused-here input filter / PII scanner) now sourced
    // from the shared core module per AUDIT-HIGH-007 / ADR-028.
    AiSafetyCoreModule,
  ],
  providers: [
    // Services
    EmailService,
    SmsService,
    PushService,
    NotificationDispatcherService,
    InAppNotificationService,
    DeadLetterQueueService,

    // Scheduled jobs
    NotificationRetentionService,
    RetrySchedulerService,

    // Event Handlers
    AlertTriggeredEventHandler,
    AuthEventHandler,
    BillingEventHandler,
    TaskEventHandler,
    MessagingEventHandler,
    NotificationCommandHandler,
    RegulatoryReportEventHandler,
    HarvestRegulatoryRecordedEventHandler,
    FeedingDailySummaryEventHandler,
    DeviceTokenRevocationHandler,

    // Resolvers
    NotificationResolver,
  ],
  exports: [NotificationDispatcherService, EmailService, SmsService, PushService, InAppNotificationService, DeadLetterQueueService],
})
export class NotificationModule {}
