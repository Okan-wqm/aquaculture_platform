import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotificationLog,
  NotificationStatus,
  NotificationChannel,
} from '../entities/notification-log.entity';
import { EmailService, AlertEmailData } from './email.service';
import { SmsService } from './sms.service';
import { PushService } from './push.service';

/**
 * Alert notification data
 */
export interface AlertNotificationData {
  alertId: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  message: string;
  farmName?: string;
  pondName?: string;
  sensorId?: string;
  timestamp?: Date;
}

/**
 * Notification Dispatcher Service
 * Orchestrates sending notifications across multiple channels
 */
@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  constructor(
    @InjectRepository(NotificationLog)
    private readonly logRepository: Repository<NotificationLog>,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly pushService: PushService,
  ) {}

  /**
   * Dispatch alert notifications to all specified channels and recipients
   */
  async dispatchAlertNotification(
    tenantId: string,
    channels: string[],
    recipients: string[],
    alertData: AlertNotificationData,
  ): Promise<void> {
    this.logger.log(
      `Dispatching alert ${alertData.alertId} to ${recipients.length} recipients via ${channels.length} channels`,
    );

    const notifications: Promise<void>[] = [];

    for (const channel of channels) {
      for (const recipient of recipients) {
        notifications.push(
          this.sendNotification(
            channel as NotificationChannel,
            recipient,
            tenantId,
            alertData,
          ),
        );
      }
    }

    // Send all notifications concurrently
    const results = await Promise.allSettled(notifications);

    // Log summary
    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    this.logger.log(
      `Alert ${alertData.alertId}: ${successful} notifications sent, ${failed} failed`,
    );
  }

  /**
   * Send a single notification
   */
  private async sendNotification(
    channel: NotificationChannel,
    recipient: string,
    tenantId: string,
    alertData: AlertNotificationData,
  ): Promise<void> {
    // Create log entry
    const log = this.logRepository.create({
      tenantId,
      channel,
      recipient,
      subject: `[${alertData.severity}] ${alertData.ruleName}`,
      content: alertData.message,
      metadata: {
        alertId: alertData.alertId,
        ruleId: alertData.ruleId,
        severity: alertData.severity,
      },
      status: NotificationStatus.PENDING,
    });

    await this.logRepository.save(log);

    try {
      let externalId: string;

      switch (channel) {
        case NotificationChannel.EMAIL:
          externalId = await this.sendEmail(recipient, alertData);
          break;
        case NotificationChannel.SMS:
          externalId = await this.sendSms(recipient, alertData);
          break;
        case NotificationChannel.PUSH:
          externalId = await this.sendPush(recipient, alertData);
          break;
        case NotificationChannel.WEBHOOK:
          externalId = await this.sendWebhook(recipient, alertData);
          break;
        default:
          throw new Error(`Unknown notification channel: ${channel}`);
      }

      // Update log on success
      log.status = NotificationStatus.SENT;
      log.externalId = externalId;
      log.sentAt = new Date();
      await this.logRepository.save(log);

      this.logger.debug(
        `Notification sent via ${channel} to ${recipient}: ${externalId}`,
      );
    } catch (error) {
      // Update log on failure
      log.status = NotificationStatus.FAILED;
      log.errorMessage = (error as Error).message;
      await this.logRepository.save(log);

      this.logger.error(
        `Failed to send ${channel} notification to ${recipient}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Send email notification
   */
  private async sendEmail(
    recipient: string,
    alertData: AlertNotificationData,
  ): Promise<string> {
    const emailData: AlertEmailData = {
      ruleName: alertData.ruleName,
      severity: alertData.severity,
      message: alertData.message,
      farmName: alertData.farmName,
      pondName: alertData.pondName,
      sensorId: alertData.sensorId,
      timestamp: alertData.timestamp,
    };

    return await this.emailService.sendAlertEmail(recipient, emailData);
  }

  /**
   * Send SMS notification
   */
  private async sendSms(
    recipient: string,
    alertData: AlertNotificationData,
  ): Promise<string> {
    return await this.smsService.sendAlertSms(recipient, {
      ruleName: alertData.ruleName,
      severity: alertData.severity,
      message: alertData.message,
    });
  }

  /**
   * Send push notification
   */
  private async sendPush(
    recipient: string,
    alertData: AlertNotificationData,
  ): Promise<string> {
    return await this.pushService.sendAlertPush(recipient, {
      ruleName: alertData.ruleName,
      severity: alertData.severity,
      message: alertData.message,
      alertId: alertData.alertId,
    });
  }

  /**
   * Send webhook notification
   */
  private async sendWebhook(
    webhookUrl: string,
    alertData: AlertNotificationData,
  ): Promise<string> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'alert',
          alertId: alertData.alertId,
          ruleId: alertData.ruleId,
          ruleName: alertData.ruleName,
          severity: alertData.severity,
          message: alertData.message,
          timestamp: alertData.timestamp || new Date(),
        }),
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }

      return `webhook-${Date.now()}`;
    } catch (error) {
      this.logger.error(
        `Webhook failed for ${webhookUrl}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Retry failed notifications
   */
  async retryFailedNotifications(maxRetries: number = 3): Promise<number> {
    const failedNotifications = await this.logRepository.find({
      where: {
        status: NotificationStatus.FAILED,
      },
      order: { createdAt: 'ASC' },
      take: 100,
    });

    let retried = 0;

    for (const notification of failedNotifications) {
      if (notification.retryCount >= maxRetries) {
        continue;
      }

      notification.status = NotificationStatus.RETRYING;
      notification.retryCount++;
      await this.logRepository.save(notification);

      // Attempt to resend
      // This would need the original alert data, which should be stored in metadata
      retried++;
    }

    return retried;
  }
}
