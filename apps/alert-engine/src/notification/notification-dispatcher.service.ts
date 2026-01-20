import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationChannel } from '../database/entities/escalation-policy.entity';
import { AlertIncident } from '../database/entities/alert-incident.entity';
import { AlertSeverity } from '../database/entities/alert-rule.entity';
import { ChannelRouterService, RoutingDecision } from './channel-router.service';
import { TemplateRendererService, RenderedNotification, TemplateContext } from './template-renderer.service';

/**
 * Notification request
 */
export interface NotificationRequest {
  incidentId: string;
  tenantId: string;
  userId: string;
  channels?: NotificationChannel[];
  severity: AlertSeverity;
  escalationLevel: number;
  context: TemplateContext;
  priority?: NotificationPriority;
  metadata?: Record<string, unknown>;
}

/**
 * Notification priority
 */
export enum NotificationPriority {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  NORMAL = 'NORMAL',
  LOW = 'LOW',
}

/**
 * Notification result
 */
export interface NotificationResult {
  requestId: string;
  userId: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  sentAt?: Date;
  deliveredAt?: Date;
  error?: string;
  retryCount?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Notification status
 */
export enum NotificationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING',
  SKIPPED = 'SKIPPED',
}

/**
 * Batch notification request
 */
export interface BatchNotificationRequest {
  incidentId: string;
  tenantId: string;
  userIds: string[];
  channels?: NotificationChannel[];
  severity: AlertSeverity;
  escalationLevel: number;
  context: TemplateContext;
  priority?: NotificationPriority;
}

/**
 * Batch notification result
 */
export interface BatchNotificationResult {
  requestId: string;
  totalUsers: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  results: NotificationResult[];
  startedAt: Date;
  completedAt: Date;
}

/**
 * Channel handler interface
 */
export interface ChannelHandler {
  send(
    userId: string,
    notification: RenderedNotification,
    metadata?: Record<string, unknown>,
  ): Promise<{ success: boolean; messageId?: string; error?: string }>;
}

/**
 * Events emitted by notification dispatcher
 */
export const NOTIFICATION_EVENTS = {
  SENT: 'notification.sent',
  DELIVERED: 'notification.delivered',
  FAILED: 'notification.failed',
  BATCH_COMPLETED: 'notification.batch.completed',
};

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);
  private channelHandlers: Map<NotificationChannel, ChannelHandler> = new Map();
  private pendingQueue: Map<string, NotificationRequest> = new Map();
  private processingQueue: Set<string> = new Set();
  private retryConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG };
  private requestCounter = 0;

  constructor(
    private readonly channelRouter: ChannelRouterService,
    private readonly templateRenderer: TemplateRendererService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Send notification
   */
  async send(request: NotificationRequest): Promise<NotificationResult[]> {
    const requestId = this.generateRequestId();
    this.logger.log(`Processing notification request ${requestId} for user ${request.userId}`);

    // Route notification to channels
    const routingDecision = this.channelRouter.route(
      request.userId,
      request.severity,
      request.channels,
      { incidentId: request.incidentId, tenantId: request.tenantId },
    );

    if (routingDecision.channels.length === 0) {
      this.logger.warn(`No channels available for user ${request.userId}`);
      return [{
        requestId,
        userId: request.userId,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.SKIPPED,
        metadata: { reason: routingDecision.reason },
      }];
    }

    const results: NotificationResult[] = [];

    for (const channel of routingDecision.channels) {
      const result = await this.sendToChannel(
        requestId,
        request.userId,
        channel,
        request.context,
        request.severity,
        request.metadata,
      );
      results.push(result);
    }

    return results;
  }

  /**
   * Send batch notification
   */
  async sendBatch(request: BatchNotificationRequest): Promise<BatchNotificationResult> {
    const requestId = this.generateRequestId();
    const startedAt = new Date();

    this.logger.log(`Processing batch notification ${requestId} for ${request.userIds.length} users`);

    const allResults: NotificationResult[] = [];
    let successCount = 0;
    let failureCount = 0;
    let skippedCount = 0;

    // Process users in parallel with concurrency limit
    const concurrencyLimit = 10;
    const chunks = this.chunkArray(request.userIds, concurrencyLimit);

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(userId =>
          this.send({
            incidentId: request.incidentId,
            tenantId: request.tenantId,
            userId,
            channels: request.channels,
            severity: request.severity,
            escalationLevel: request.escalationLevel,
            context: request.context,
            priority: request.priority,
          }),
        ),
      );

      for (const results of chunkResults) {
        for (const result of results) {
          allResults.push(result);

          if (result.status === NotificationStatus.SENT || result.status === NotificationStatus.DELIVERED) {
            successCount++;
          } else if (result.status === NotificationStatus.FAILED) {
            failureCount++;
          } else if (result.status === NotificationStatus.SKIPPED) {
            skippedCount++;
          }
        }
      }
    }

    const batchResult: BatchNotificationResult = {
      requestId,
      totalUsers: request.userIds.length,
      successCount,
      failureCount,
      skippedCount,
      results: allResults,
      startedAt,
      completedAt: new Date(),
    };

    this.eventEmitter.emit(NOTIFICATION_EVENTS.BATCH_COMPLETED, batchResult);

    return batchResult;
  }

  /**
   * Send to specific channel
   */
  async sendToChannel(
    requestId: string,
    userId: string,
    channel: NotificationChannel,
    context: TemplateContext,
    severity: AlertSeverity,
    metadata?: Record<string, unknown>,
  ): Promise<NotificationResult> {
    const handler = this.channelHandlers.get(channel);

    if (!handler) {
      this.logger.warn(`No handler registered for channel ${channel}`);
      return {
        requestId,
        userId,
        channel,
        status: NotificationStatus.SKIPPED,
        error: `No handler for channel ${channel}`,
      };
    }

    // Render notification
    const rendered = this.templateRenderer.render(channel, context);

    try {
      const result = await handler.send(userId, rendered, metadata);

      if (result.success) {
        const notificationResult: NotificationResult = {
          requestId,
          userId,
          channel,
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          metadata: { messageId: result.messageId },
        };

        this.eventEmitter.emit(NOTIFICATION_EVENTS.SENT, notificationResult);

        return notificationResult;
      } else {
        // Attempt retry
        return this.handleFailure(requestId, userId, channel, context, severity, result.error, metadata);
      }
    } catch (error: any) {
      return this.handleFailure(requestId, userId, channel, context, severity, error.message, metadata);
    }
  }

  /**
   * Handle notification failure
   */
  private async handleFailure(
    requestId: string,
    userId: string,
    channel: NotificationChannel,
    context: TemplateContext,
    severity: AlertSeverity,
    error?: string,
    metadata?: Record<string, unknown>,
    retryCount = 0,
  ): Promise<NotificationResult> {
    this.logger.error(`Notification failed for user ${userId} on channel ${channel}: ${error}`);

    if (retryCount < this.retryConfig.maxRetries) {
      // Schedule retry
      const delay = Math.min(
        this.retryConfig.initialDelayMs * Math.pow(this.retryConfig.backoffMultiplier, retryCount),
        this.retryConfig.maxDelayMs,
      );

      this.logger.log(`Scheduling retry ${retryCount + 1} for ${requestId} in ${delay}ms`);

      return new Promise(resolve => {
        setTimeout(async () => {
          const result = await this.retryNotification(
            requestId,
            userId,
            channel,
            context,
            severity,
            metadata,
            retryCount + 1,
          );
          resolve(result);
        }, delay);
      });
    }

    const failureResult: NotificationResult = {
      requestId,
      userId,
      channel,
      status: NotificationStatus.FAILED,
      error,
      retryCount,
    };

    this.eventEmitter.emit(NOTIFICATION_EVENTS.FAILED, failureResult);

    return failureResult;
  }

  /**
   * Retry notification
   */
  private async retryNotification(
    requestId: string,
    userId: string,
    channel: NotificationChannel,
    context: TemplateContext,
    severity: AlertSeverity,
    metadata?: Record<string, unknown>,
    retryCount = 0,
  ): Promise<NotificationResult> {
    const handler = this.channelHandlers.get(channel);

    if (!handler) {
      return {
        requestId,
        userId,
        channel,
        status: NotificationStatus.FAILED,
        error: `No handler for channel ${channel}`,
        retryCount,
      };
    }

    const rendered = this.templateRenderer.render(channel, context);

    try {
      const result = await handler.send(userId, rendered, metadata);

      if (result.success) {
        return {
          requestId,
          userId,
          channel,
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          retryCount,
          metadata: { messageId: result.messageId },
        };
      } else {
        return this.handleFailure(
          requestId,
          userId,
          channel,
          context,
          severity,
          result.error,
          metadata,
          retryCount,
        );
      }
    } catch (error: any) {
      return this.handleFailure(
        requestId,
        userId,
        channel,
        context,
        severity,
        error.message,
        metadata,
        retryCount,
      );
    }
  }

  /**
   * Register channel handler
   */
  registerHandler(channel: NotificationChannel, handler: ChannelHandler): void {
    this.channelHandlers.set(channel, handler);
    this.logger.log(`Registered handler for channel ${channel}`);
  }

  /**
   * Unregister channel handler
   */
  unregisterHandler(channel: NotificationChannel): boolean {
    return this.channelHandlers.delete(channel);
  }

  /**
   * Check if handler is registered
   */
  hasHandler(channel: NotificationChannel): boolean {
    return this.channelHandlers.has(channel);
  }

  /**
   * Get registered handlers
   */
  getRegisteredHandlers(): NotificationChannel[] {
    return Array.from(this.channelHandlers.keys());
  }

  /**
   * Set retry configuration
   */
  setRetryConfig(config: Partial<RetryConfig>): void {
    this.retryConfig = { ...this.retryConfig, ...config };
  }

  /**
   * Get retry configuration
   */
  getRetryConfig(): RetryConfig {
    return { ...this.retryConfig };
  }

  /**
   * Queue notification for later processing
   */
  queueNotification(request: NotificationRequest): string {
    const requestId = this.generateRequestId();
    this.pendingQueue.set(requestId, request);
    return requestId;
  }

  /**
   * Process queued notifications
   */
  async processQueue(): Promise<number> {
    const requests = Array.from(this.pendingQueue.entries());
    let processed = 0;

    for (const [requestId, request] of requests) {
      if (this.processingQueue.has(requestId)) {
        continue;
      }

      this.processingQueue.add(requestId);

      try {
        await this.send(request);
        this.pendingQueue.delete(requestId);
        processed++;
      } finally {
        this.processingQueue.delete(requestId);
      }
    }

    return processed;
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.pendingQueue.size;
  }

  /**
   * Clear queue
   */
  clearQueue(): number {
    const size = this.pendingQueue.size;
    this.pendingQueue.clear();
    return size;
  }

  /**
   * Mark notification as delivered
   */
  markDelivered(requestId: string, channel: NotificationChannel, userId: string): void {
    const result: NotificationResult = {
      requestId,
      userId,
      channel,
      status: NotificationStatus.DELIVERED,
      deliveredAt: new Date(),
    };

    this.eventEmitter.emit(NOTIFICATION_EVENTS.DELIVERED, result);
  }

  /**
   * Get notification statistics
   */
  getStatistics(): Record<string, unknown> {
    return {
      registeredHandlers: this.channelHandlers.size,
      queuedNotifications: this.pendingQueue.size,
      processingNotifications: this.processingQueue.size,
      retryConfig: this.retryConfig,
    };
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    this.requestCounter++;
    return `notif-${Date.now()}-${this.requestCounter}`;
  }

  /**
   * Chunk array for parallel processing
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Test send (for debugging)
   */
  async testSend(
    channel: NotificationChannel,
    userId: string,
    context?: TemplateContext,
  ): Promise<NotificationResult> {
    const testContext: TemplateContext = context || {
      incident: {
        id: 'test-incident',
        title: 'Test Notification',
        description: 'This is a test notification.',
      } as any,
      severity: AlertSeverity.INFO,
      escalationLevel: 0,
    };

    return this.sendToChannel(
      'test-' + Date.now(),
      userId,
      channel,
      testContext,
      AlertSeverity.INFO,
      { isTest: true },
    );
  }
}
