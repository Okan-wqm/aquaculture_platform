import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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

// Blocked hosts for SSRF prevention
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254', // AWS metadata
  'metadata.google.internal', // GCP metadata
];

// Blocked IP patterns for SSRF prevention (private ranges)
const BLOCKED_IP_PATTERNS = [
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^fc00:/, // IPv6 unique local
  /^fe80:/, // IPv6 link-local
];

/**
 * Validate webhook URL to prevent SSRF attacks
 */
function isValidWebhookUrl(urlString: string): { valid: boolean; reason?: string } {
  try {
    const url = new URL(urlString);

    // Only allow HTTPS in production (HTTP for development)
    const allowHttp = process.env['NODE_ENV'] !== 'production';
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      return { valid: false, reason: 'Only HTTPS URLs are allowed' };
    }

    // Check blocked hosts
    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
      return { valid: false, reason: 'Hostname is not allowed' };
    }

    // Check IP patterns
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return { valid: false, reason: 'Private IP addresses are not allowed' };
      }
    }

    // Don't allow non-standard ports in production
    if (process.env['NODE_ENV'] === 'production' && url.port && !['443', '80'].includes(url.port)) {
      return { valid: false, reason: 'Non-standard ports are not allowed in production' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
}

// Rate limiting: track requests per tenant
const tenantRequestCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_NOTIFICATIONS_PER_MINUTE = 100;

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
    // Validate inputs
    if (!channels || channels.length === 0) {
      throw new BadRequestException('At least one notification channel is required');
    }
    if (!recipients || recipients.length === 0) {
      throw new BadRequestException('At least one recipient is required');
    }

    // Rate limiting check
    const totalNotifications = channels.length * recipients.length;
    if (!this.checkRateLimit(tenantId, totalNotifications)) {
      this.logger.warn(
        `Rate limit exceeded for tenant ${tenantId}. Dropping ${totalNotifications} notifications.`,
      );
      throw new BadRequestException('Rate limit exceeded. Please try again later.');
    }

    // Validate channel types
    const validChannels = Object.values(NotificationChannel);
    for (const channel of channels) {
      if (!validChannels.includes(channel as NotificationChannel)) {
        throw new BadRequestException(`Invalid notification channel: ${channel}`);
      }
    }

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
   * Check and update rate limit for a tenant
   */
  private checkRateLimit(tenantId: string, count: number): boolean {
    const now = Date.now();
    const entry = tenantRequestCounts.get(tenantId);

    if (!entry || entry.resetAt < now) {
      // Reset counter
      tenantRequestCounts.set(tenantId, {
        count,
        resetAt: now + 60000, // 1 minute window
      });
      return true;
    }

    if (entry.count + count > MAX_NOTIFICATIONS_PER_MINUTE) {
      return false;
    }

    entry.count += count;
    return true;
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
   * Validates URL to prevent SSRF attacks and uses timeout
   */
  private async sendWebhook(
    webhookUrl: string,
    alertData: AlertNotificationData,
  ): Promise<string> {
    // SECURITY: Validate webhook URL to prevent SSRF
    const validation = isValidWebhookUrl(webhookUrl);
    if (!validation.valid) {
      this.logger.warn(
        `Webhook URL rejected: ${validation.reason} (URL redacted for security)`,
      );
      throw new Error(`Invalid webhook URL: ${validation.reason}`);
    }

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AquaculturePlatform-Webhook/1.0',
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
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }

      return `webhook-${Date.now()}`;
    } catch (error) {
      const errorMessage = (error as Error).name === 'AbortError'
        ? 'Webhook request timed out'
        : (error as Error).message;

      // Don't log the full URL for security reasons
      this.logger.error(`Webhook failed: ${errorMessage}`);
      throw new Error(`Webhook failed: ${errorMessage}`);
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
