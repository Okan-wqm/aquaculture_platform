import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { NotificationLog } from './entities/notification-log.entity';

// Services
import { EmailService } from './services/email.service';
import { SmsService } from './services/sms.service';
import { PushService } from './services/push.service';
import { NotificationDispatcherService } from './services/notification-dispatcher.service';

// Event Handlers
import { AlertTriggeredEventHandler } from './event-handlers/alert-triggered.handler';

/**
 * Notification Module
 * Contains all notification-related functionality including:
 * - Multi-channel notification dispatch (Email, SMS, Push, Webhook)
 * - Notification logging and tracking
 * - Retry mechanism for failed notifications
 */
@Module({
  imports: [TypeOrmModule.forFeature([NotificationLog])],
  providers: [
    // Services
    EmailService,
    SmsService,
    PushService,
    NotificationDispatcherService,

    // Event Handlers
    AlertTriggeredEventHandler,
  ],
  exports: [NotificationDispatcherService, EmailService, SmsService, PushService],
})
export class NotificationModule {}
