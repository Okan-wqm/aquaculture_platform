import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';
import { InAppNotificationService } from '../services/in-app.service';
import { PushService } from '../services/push.service';
import { DeadLetterQueueService } from '../services/dead-letter-queue.service';
import { DeviceToken } from '../entities/device-token.entity';
import type {
  TaskEvent,
  TaskCreatedEvent,
  TaskAssignedEvent,
  TaskStatusChangedEvent,
  TaskCompletedEvent,
  TaskOverdueEvent,
} from '@platform/event-contracts';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Maximum number of task events processed concurrently (backpressure).
 */
const MAX_EVENT_CONCURRENCY = 5;

/**
 * Minimal async semaphore -- caps concurrent executions without an external dep.
 */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.active--;
    if (this.queue.length > 0 && this.active < this.limit) {
      this.active++;
      const next = this.queue.shift()!;
      next();
    }
  }
}

/**
 * Task Event Handler
 * Listens to all task-related events and creates in-app notifications.
 *
 * Subscribed events:
 * - TaskCreated: Notify assignee about new task creation
 * - TaskAssigned: Notify assignee about task assignment
 * - TaskStatusChanged: Notify assignee about task status changes
 * - TaskCompleted: Notify assignee about task completion
 * - TaskOverdue: Notify assignee about overdue tasks
 *
 * Backpressure: A semaphore caps the number of concurrently processed
 * task events at MAX_EVENT_CONCURRENCY.
 */
@Injectable()
export class TaskEventHandler
  implements IEventHandler<TaskEvent>, OnModuleInit
{
  private readonly logger = new Logger(TaskEventHandler.name);
  private readonly semaphore = new Semaphore(MAX_EVENT_CONCURRENCY);

  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    private readonly inAppService: InAppNotificationService,
    private readonly pushService: PushService,
    private readonly dlqService: DeadLetterQueueService,
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Subscribe to all task events
    await this.eventBus.subscribe('TaskCreated', this);
    await this.eventBus.subscribe('TaskAssigned', this);
    await this.eventBus.subscribe('TaskStatusChanged', this);
    await this.eventBus.subscribe('TaskCompleted', this);
    await this.eventBus.subscribe('TaskOverdue', this);
    this.logger.log(
      'Subscribed to TaskCreated, TaskAssigned, TaskStatusChanged, TaskCompleted, and TaskOverdue events',
    );
  }

  getEventType(): string {
    return 'TaskEvent';
  }

  async handle(event: TaskEvent): Promise<void> {
    // SECURITY: Validate tenantId format to ensure data isolation
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `Task event has invalid or missing tenantId. ` +
        'Skipping to prevent cross-tenant notification leakage.',
      );
      return;
    }

    const eventType = event.eventType;

    // Validate required fields common to all task events
    if (!event.taskId) {
      this.logger.error(
        `Task event missing required field (taskId). Skipping.`,
      );
      return;
    }

    this.logger.log(
      `Processing ${eventType} for task ${event.taskId.substring(0, 8)}... ` +
      `in tenant ${event.tenantId.substring(0, 8)}...`,
    );

    // Acquire semaphore slot before processing to enforce backpressure
    await this.semaphore.acquire();

    try {
      switch (eventType) {
        case 'TaskCreated':
          await this.handleTaskCreated(event as TaskCreatedEvent);
          break;
        case 'TaskAssigned':
          await this.handleTaskAssigned(event as TaskAssignedEvent);
          break;
        case 'TaskStatusChanged':
          await this.handleTaskStatusChanged(event as TaskStatusChangedEvent);
          break;
        case 'TaskCompleted':
          await this.handleTaskCompleted(event as TaskCompletedEvent);
          break;
        case 'TaskOverdue':
          await this.handleTaskOverdue(event as TaskOverdueEvent);
          break;
        default:
          this.logger.warn(`Unknown task event type: ${eventType}`);
      }
    } catch (error) {
      this.logger.error(
        `Error processing ${eventType} event: ${(error as Error).message}`,
        (error as Error).stack,
      );

      // DLQ: Determine whether to retry or dead-letter this event
      try {
        const dlqResult = await this.dlqService.handleFailedEvent(
          event as unknown as Record<string, unknown>,
          error,
        );

        if (dlqResult.retry) {
          // Re-publish with incremented retryCount and a fresh eventId
          // to bypass NATS deduplication window
          await this.eventBus.publish({
            ...(event as any),
            retryCount: dlqResult.retryCount,
            eventId: crypto.randomUUID(),
          });
          this.logger.warn(
            `Task event ${eventType} (task ${event.taskId.substring(0, 8)}...) ` +
            `re-published for retry attempt ${dlqResult.retryCount}`,
          );
        }
      } catch (dlqError) {
        this.logger.error(
          `DLQ handling failed for ${eventType}: ${(dlqError as Error).message}`,
        );
      }
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Send push notifications to all registered devices for a user.
   * Fire-and-forget: logs errors but does not throw.
   */
  private async sendPushToUser(
    tenantId: string,
    userId: string,
    taskId: string,
    title: string,
    eventType: string,
  ): Promise<void> {
    try {
      const tokens = await this.deviceTokenRepository.find({
        where: { userId, tenantId },
      });

      if (tokens.length === 0) {
        this.logger.debug(
          `No device tokens found for user ${userId.substring(0, 8)}... -- skipping push`,
        );
        return;
      }

      for (const dt of tokens) {
        try {
          await this.pushService.sendTaskPush(dt.token, {
            title,
            taskId,
            type: eventType,
          });
        } catch (pushErr) {
          this.logger.warn(
            `Push failed for device ${dt.id.substring(0, 8)}...: ${(pushErr as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to look up device tokens for push: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Handle TaskCreated event - notify assignee about new task creation
   */
  private async handleTaskCreated(event: TaskCreatedEvent): Promise<void> {
    if (!event.assignedTo) {
      this.logger.warn(
        `TaskCreated event missing assignedTo. Skipping notification.`,
      );
      return;
    }

    const title = `Yeni g\u00F6rev olu\u015Fturuldu: ${event.title}`;
    const body = `Size yeni bir g\u00F6rev olu\u015Fturuldu: ${event.title}`;

    await this.inAppService.createNotification(
      event.tenantId,
      event.assignedTo,
      title,
      body,
      {
        type: 'TaskCreated',
        taskId: event.taskId,
        category: event.category,
        dueDate: event.dueDate,
        priority: event.priority,
        createdBy: event.createdBy,
      },
    );

    // Send push notification to assignee's devices
    await this.sendPushToUser(
      event.tenantId,
      event.assignedTo,
      event.taskId,
      title,
      'TaskCreated',
    );

    this.logger.debug(
      `In-app notification created for TaskCreated: task ${event.taskId.substring(0, 8)}...`,
    );
  }

  /**
   * Handle TaskAssigned event - create in-app notification for the assignee
   */
  private async handleTaskAssigned(event: TaskAssignedEvent): Promise<void> {
    if (!event.assignedTo) {
      this.logger.warn(
        `TaskAssigned event missing assignedTo. Skipping notification.`,
      );
      return;
    }

    const title = `Yeni g\u00F6rev atand\u0131: ${event.title}`;
    const body = `Size yeni bir g\u00F6rev atand\u0131: ${event.title}`;

    await this.inAppService.createNotification(
      event.tenantId,
      event.assignedTo,
      title,
      body,
      {
        type: 'TaskAssigned',
        taskId: event.taskId,
        assignedBy: event.assignedBy,
        dueDate: event.dueDate,
        priority: event.priority,
      },
    );

    // Send push notification to assignee's devices
    await this.sendPushToUser(
      event.tenantId,
      event.assignedTo,
      event.taskId,
      title,
      'TaskAssigned',
    );

    this.logger.debug(
      `In-app + push notification sent for TaskAssigned: task ${event.taskId.substring(0, 8)}...`,
    );
  }

  /**
   * Handle TaskStatusChanged event - notify assignee about status change
   */
  private async handleTaskStatusChanged(event: TaskStatusChangedEvent): Promise<void> {
    const taskTitle = (event as any).title || event.taskId.substring(0, 8);
    const title = `G\u00F6rev durumu de\u011Fi\u015Fti: ${taskTitle}`;
    const body = `"${taskTitle}" g\u00F6revinin durumu de\u011Fi\u015Fti: ${event.previousStatus} \u2192 ${event.newStatus}`;

    // TaskStatusChanged does not carry assignedTo; notify the user who changed it
    // so they get confirmation, and rely on changedBy as the recipient.
    const recipientId = event.changedBy || event.userId;
    if (!recipientId) {
      this.logger.warn(
        `TaskStatusChanged event missing changedBy and userId. Skipping notification.`,
      );
      return;
    }

    await this.inAppService.createNotification(
      event.tenantId,
      recipientId,
      title,
      body,
      {
        type: 'TaskStatusChanged',
        taskId: event.taskId,
        previousStatus: event.previousStatus,
        newStatus: event.newStatus,
        changedBy: event.changedBy,
      },
    );

    // TODO: Add push notification for status changes once TaskStatusChangedEvent
    // includes an assignedTo field so we can reliably determine the notification recipient.

    this.logger.debug(
      `In-app notification created for TaskStatusChanged: task ${event.taskId.substring(0, 8)}...`,
    );
  }

  /**
   * Handle TaskCompleted event - notify assignee about task completion
   */
  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    if (!event.assignedTo) {
      this.logger.warn(
        `TaskCompleted event missing assignedTo. Skipping notification.`,
      );
      return;
    }

    const title = `G\u00F6rev tamamland\u0131: ${event.title}`;
    const body = `G\u00F6reviniz tamamland\u0131: ${event.title}`;

    await this.inAppService.createNotification(
      event.tenantId,
      event.assignedTo,
      title,
      body,
      {
        type: 'TaskCompleted',
        taskId: event.taskId,
        completedBy: event.completedBy,
        completedAt: event.completedAt?.toString(),
      },
    );

    // Send push notification to assignee's devices
    await this.sendPushToUser(
      event.tenantId,
      event.assignedTo,
      event.taskId,
      title,
      'TaskCompleted',
    );

    this.logger.debug(
      `In-app + push notification sent for TaskCompleted: task ${event.taskId.substring(0, 8)}...`,
    );
  }

  /**
   * Handle TaskOverdue event - create in-app notification for the assignee
   */
  private async handleTaskOverdue(event: TaskOverdueEvent): Promise<void> {
    if (!event.assignedTo) {
      this.logger.warn(
        `TaskOverdue event missing assignedTo. Skipping notification.`,
      );
      return;
    }

    const title = `Gecikmi\u015F g\u00F6rev: ${event.title}`;
    const body = `G\u00F6reviniz gecikmi\u015F durumda: ${event.title}`;

    await this.inAppService.createNotification(
      event.tenantId,
      event.assignedTo,
      title,
      body,
      {
        type: 'TaskOverdue',
        taskId: event.taskId,
        dueDate: event.dueDate,
        priority: event.priority,
        hoursOverdue: event.hoursOverdue,
      },
    );

    // Send push notification to assignee's devices
    await this.sendPushToUser(
      event.tenantId,
      event.assignedTo,
      event.taskId,
      title,
      'TaskOverdue',
    );

    this.logger.debug(
      `In-app + push notification sent for TaskOverdue: task ${event.taskId.substring(0, 8)}...`,
    );
  }
}
