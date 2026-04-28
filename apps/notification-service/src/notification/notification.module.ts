import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import { NotificationLog } from './entities/notification-log.entity';
import { DeviceToken } from './entities/device-token.entity';

// Services
import { EmailService } from './services/email.service';
import { SmsService } from './services/sms.service';
import { PushService } from './services/push.service';
import { NotificationDispatcherService } from './services/notification-dispatcher.service';
import { NotificationRetentionService } from './services/notification-retention.service';
import { RetrySchedulerService } from './services/retry-scheduler.service';
import { InAppNotificationService } from './services/in-app.service';
import { DeadLetterQueueService } from './services/dead-letter-queue.service';
import { AiSafetyCoreModule } from '@aquaculture/backend-common/ai-safety';

// Event Handlers
import { AlertTriggeredEventHandler } from './event-handlers/alert-triggered.handler';
import { AuthEventHandler } from './event-handlers/auth-event.handler';
import { BillingEventHandler } from './event-handlers/billing-event.handler';
import { TaskEventHandler } from './event-handlers/task-event.handler';
import { MessagingEventHandler } from './event-handlers/messaging-event.handler';

// Resolvers
import { NotificationResolver } from './resolvers/notification.resolver';

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

    // Resolvers
    NotificationResolver,
  ],
  exports: [NotificationDispatcherService, EmailService, SmsService, PushService, InAppNotificationService, DeadLetterQueueService],
})
export class NotificationModule {}
