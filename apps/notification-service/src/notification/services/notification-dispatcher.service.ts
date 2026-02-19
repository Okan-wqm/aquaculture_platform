import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
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
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
  /^198\.1[89]\./, // 198.18.0.0/15 (benchmark)
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

/**
 * Redact sensitive parts from webhook URL for safe logging/storage
 * Strips query params that may contain credentials
 */
function redactWebhookUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    url.search = '';
    url.hash = '';
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

// Concurrency limit for parallel notification dispatch
const MAX_CONCURRENCY = 10;

/**
 * Simple concurrency limiter (avoids external dependency)
 */
function pLimit(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const fn = queue.shift()!;
      fn();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      };

      queue.push(run);
      next();
    });
  };
}

// Exponential backoff base delay for retries (1 minute)
const RETRY_BASE_DELAY_MS = 60 * 1000;

// Rate limiting: track requests per tenant
// NOTE: This in-memory rate limiting has limitations in multi-instance deployments.
// For production horizontal scaling, replace with Redis-based INCRBY/EXPIRE.
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
    private readonly dataSource: DataSource,
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

    // Deduplication: skip channel+recipient pairs that already have a
    // non-failed log entry for this alertId (handles NATS at-least-once redelivery).
    const existingLogs = await this.logRepository.find({
      where: channels.flatMap((channel) =>
        recipients.map((recipient) => ({
          tenantId,
          channel: channel as NotificationChannel,
          recipient: channel === NotificationChannel.WEBHOOK ? redactWebhookUrl(recipient) : recipient,
          status: In([NotificationStatus.SENT, NotificationStatus.PENDING, NotificationStatus.RETRYING]),
        })),
      ),
      select: ['channel', 'recipient', 'metadata'],
    });

    // Build a set of already-dispatched channel+recipient keys for fast lookup.
    // Only deduplicate when metadata.alertId matches the current alert to avoid
    // blocking unrelated notifications to the same recipient.
    const alreadySent = new Set<string>(
      existingLogs
        .filter((log) => {
          const meta = log.metadata as Record<string, unknown> | undefined;
          return meta?.['alertId'] === alertData.alertId;
        })
        .map((log) => `${log.channel}:${log.recipient}`),
    );

    if (alreadySent.size > 0) {
      this.logger.warn(
        `Alert ${alertData.alertId}: skipping ${alreadySent.size} already-dispatched channel+recipient pair(s) (deduplication)`,
      );
    }

    this.logger.log(
      `Dispatching alert ${alertData.alertId} to ${recipients.length} recipients via ${channels.length} channels`,
    );

    // Use concurrency limiter to prevent thundering herd
    const limit = pLimit(MAX_CONCURRENCY);
    const notifications: Promise<void>[] = [];

    for (const channel of channels) {
      for (const recipient of recipients) {
        // Determine the stored recipient value (webhook URLs are redacted)
        const logRecipientKey = channel === NotificationChannel.WEBHOOK
          ? redactWebhookUrl(recipient)
          : recipient;

        // Skip if this channel+recipient was already successfully dispatched
        if (alreadySent.has(`${channel}:${logRecipientKey}`)) {
          this.logger.debug(
            `Skipping duplicate notification: channel=${channel}, recipient=[redacted for dedup check]`,
          );
          continue;
        }

        notifications.push(
          limit(() =>
            this.sendNotification(
              channel as NotificationChannel,
              recipient,
              tenantId,
              alertData,
            ),
          ),
        );
      }
    }

    // Send all notifications with bounded concurrency
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
   * NOTE: For multi-instance deployments, replace with Redis INCRBY/EXPIRE
   */
  private checkRateLimit(tenantId: string, count: number): boolean {
    const now = Date.now();
    const entry = tenantRequestCounts.get(tenantId);

    // Handle expired or missing entry.
    // Explicitly delete the stale entry before re-setting to prevent unbounded
    // map growth in deployments with many infrequently-alerting tenants.
    if (!entry || entry.resetAt < now) {
      if (entry) {
        tenantRequestCounts.delete(tenantId);
      }
      tenantRequestCounts.set(tenantId, {
        count,
        resetAt: now + 60000, // 1 minute window
      });
      return count <= MAX_NOTIFICATIONS_PER_MINUTE;
    }

    // Check limit
    if (entry.count + count > MAX_NOTIFICATIONS_PER_MINUTE) {
      return false;
    }

    entry.count += count;
    return true;
  }

  /**
   * Send a single notification
   * Persists only the final state to reduce DB write load
   */
  private async sendNotification(
    channel: NotificationChannel,
    recipient: string,
    tenantId: string,
    alertData: AlertNotificationData,
  ): Promise<void> {
    // For webhooks, redact the URL before storing in the log to avoid leaking credentials
    const logRecipient = channel === NotificationChannel.WEBHOOK
      ? redactWebhookUrl(recipient)
      : recipient;

    // Store the full alert data in metadata so retries can reconstruct the send
    const metadata = {
      alertId: alertData.alertId,
      ruleId: alertData.ruleId,
      severity: alertData.severity,
      alertData: {
        ruleName: alertData.ruleName,
        message: alertData.message,
        farmName: alertData.farmName,
        pondName: alertData.pondName,
        sensorId: alertData.sensorId,
        timestamp: alertData.timestamp,
      },
    };

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

      // Persist success state directly (skip PENDING save to halve DB writes)
      const log = this.logRepository.create({
        tenantId,
        channel,
        recipient: logRecipient,
        subject: `[${alertData.severity}] ${alertData.ruleName}`.replace(/[\r\n]/g, ''),
        content: alertData.message,
        metadata,
        status: NotificationStatus.SENT,
        externalId,
        sentAt: new Date(),
      });
      await this.logRepository.save(log);

      // SECURITY (FIND-19): mask PII in debug log output
      this.logger.debug(
        `Notification sent via ${channel} to ${this.maskRecipientForLog(channel, logRecipient)}: ${externalId}`,
      );
    } catch (error) {
      // Compute next retry time using exponential backoff (base 1 minute).
      // retryCount is 0 on first failure so delay is 1 min, then 2 min, 4 min, etc.
      const nextRetryAt = new Date(Date.now() + RETRY_BASE_DELAY_MS);

      // Persist failure state directly; if the DB write itself fails, log the
      // error so the audit trail is not silently lost.
      const log = this.logRepository.create({
        tenantId,
        channel,
        recipient: logRecipient,
        subject: `[${alertData.severity}] ${alertData.ruleName}`.replace(/[\r\n]/g, ''),
        content: alertData.message,
        metadata,
        status: NotificationStatus.FAILED,
        errorMessage: (error as Error).message,
        nextRetryAt,
      });

      try {
        await this.logRepository.save(log);
      } catch (dbError) {
        this.logger.error(
          `Failed to persist failure log for ${channel} notification to ` +
          `${this.maskRecipientForLog(channel, logRecipient)}: ` +
          `${(dbError as Error).message}`,
        );
      }

      this.logger.error(
        `Failed to send ${channel} notification to ${this.maskRecipientForLog(channel, logRecipient)}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Mask a notification recipient for log output to prevent PII leakage (FIND-19).
   * - PUSH:    always '[masked-token]'  (device token is sensitive)
   * - SMS:     last 4 digits only, e.g. "***1234"
   * - EMAIL:   local-part masked, domain kept, e.g. "***@example.com"
   * - WEBHOOK: already redacted by redactWebhookUrl(); passed through as-is
   */
  private maskRecipientForLog(channel: NotificationChannel, recipient: string): string {
    switch (channel) {
      case NotificationChannel.PUSH:
        return '[masked-token]';
      case NotificationChannel.SMS:
        return recipient.length <= 4 ? '***' : '***' + recipient.slice(-4);
      case NotificationChannel.EMAIL: {
        const atIdx = recipient.indexOf('@');
        return atIdx === -1 ? '***' : '***' + recipient.slice(atIdx);
      }
      default:
        // WEBHOOK: already a redacted URL
        return recipient;
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

      // Consume response body to release the socket
      try {
        await response.text();
      } catch {
        // Ignore body read errors
      }

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
   * Retry failed notifications for a specific tenant.
   * Queries only for the specified tenant to maintain data isolation.
   * Uses a single atomic UPDATE ... RETURNING to claim records, preventing
   * concurrent invocations from double-processing the same notifications.
   * Only processes records where next_retry_at is null or has elapsed.
   */
  async retryFailedNotifications(tenantId: string, maxRetries: number = 3): Promise<number> {
    const now = new Date();

    // Atomically transition eligible records from FAILED → RETRYING and
    // increment retry_count in one statement.  Only this instance will see
    // the returned rows; any concurrent invocation will find them already
    // in RETRYING status and skip them.
    // Only claims records where next_retry_at has elapsed (exponential backoff).
    const claimed: NotificationLog[] = await this.dataSource.query(
      `UPDATE notification_logs
          SET status      = $1,
              retry_count = retry_count + 1
        WHERE tenant_id   = $2
          AND status      = $3
          AND retry_count < $4
          AND (next_retry_at IS NULL OR next_retry_at <= $5)
        ORDER BY created_at ASC
        LIMIT 100
        RETURNING *`,
      [
        NotificationStatus.RETRYING,
        tenantId,
        NotificationStatus.FAILED,
        maxRetries,
        now,
      ],
    );

    // Map raw DB rows to entity-like objects (column names are snake_case from PG)
    const failedNotifications: NotificationLog[] = (claimed as unknown as Record<string, unknown>[]).map((row) => {
      const log = new NotificationLog();
      log.id             = row['id'] as string;
      log.tenantId       = row['tenant_id'] as string;
      log.channel        = row['channel'] as NotificationChannel;
      log.recipient      = row['recipient'] as string;
      log.subject        = row['subject'] as string;
      log.content        = row['content'] as string;
      log.status         = row['status'] as NotificationStatus;
      log.externalId     = row['external_id'] as string | undefined;
      log.metadata       = row['metadata'] as Record<string, unknown> | undefined;
      log.errorMessage   = row['error_message'] as string | undefined;
      log.retryCount     = row['retry_count'] as number;
      log.nextRetryAt    = row['next_retry_at'] ? new Date(row['next_retry_at'] as string) : undefined;
      log.sentAt         = row['sent_at'] ? new Date(row['sent_at'] as string) : undefined;
      log.deliveredAt    = row['delivered_at'] ? new Date(row['delivered_at'] as string) : undefined;
      log.createdAt      = new Date(row['created_at'] as string);
      return log;
    });

    let retried = 0;

    for (const notification of failedNotifications) {
      try {
        // Reconstruct alert data from stored metadata
        const alertPayload = notification.metadata?.['alertData'] as Record<string, unknown> | undefined;
        if (!alertPayload) {
          this.logger.warn(
            `Cannot retry notification ${notification.id}: metadata.alertData missing`,
          );
          notification.status = NotificationStatus.FAILED;
          notification.errorMessage = 'Cannot retry: original alert data not available in metadata';
          notification.nextRetryAt = undefined;
          await this.logRepository.save(notification);
          continue;
        }

        const alertData: AlertNotificationData = {
          alertId: (notification.metadata?.['alertId'] as string) || '',
          ruleId: (notification.metadata?.['ruleId'] as string) || '',
          ruleName: (alertPayload['ruleName'] as string) || 'Unknown Rule',
          severity: (notification.metadata?.['severity'] as string) || 'info',
          message: (alertPayload['message'] as string) || '',
          farmName: alertPayload['farmName'] as string | undefined,
          pondName: alertPayload['pondName'] as string | undefined,
          sensorId: alertPayload['sensorId'] as string | undefined,
          timestamp: alertPayload['timestamp'] ? new Date(alertPayload['timestamp'] as string) : undefined,
        };

        let externalId: string;

        switch (notification.channel) {
          case NotificationChannel.EMAIL:
            externalId = await this.sendEmail(notification.recipient, alertData);
            break;
          case NotificationChannel.SMS:
            externalId = await this.sendSms(notification.recipient, alertData);
            break;
          case NotificationChannel.PUSH:
            externalId = await this.sendPush(notification.recipient, alertData);
            break;
          case NotificationChannel.WEBHOOK:
            // Webhook URL was redacted in storage; cannot retry webhook notifications
            this.logger.warn(`Cannot retry webhook notification ${notification.id}: URL was redacted`);
            notification.status = NotificationStatus.FAILED;
            notification.errorMessage = 'Cannot retry: webhook URL was redacted for security';
            notification.nextRetryAt = undefined;
            await this.logRepository.save(notification);
            continue;
          default:
            throw new Error(`Unknown channel: ${notification.channel}`);
        }

        notification.status = NotificationStatus.SENT;
        notification.externalId = externalId;
        notification.sentAt = new Date();
        notification.errorMessage = undefined;
        notification.nextRetryAt = undefined;
        await this.logRepository.save(notification);
        retried++;
      } catch (error) {
        // Apply exponential backoff: 2^retryCount minutes
        const backoffMs = Math.pow(2, notification.retryCount) * RETRY_BASE_DELAY_MS;
        notification.status = NotificationStatus.FAILED;
        notification.errorMessage = (error as Error).message;
        notification.nextRetryAt = new Date(Date.now() + backoffMs);
        await this.logRepository.save(notification);

        this.logger.error(
          `Retry failed for notification ${notification.id}: ${(error as Error).message}`,
        );
      }
    }

    return retried;
  }
}
