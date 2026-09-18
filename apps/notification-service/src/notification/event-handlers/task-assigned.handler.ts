import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import {
  IEventBus,
  IEventHandler,
  IEvent,
  HandlerOutcome,
  outcomeForError,
} from '@platform/event-bus';
import type { EventId } from '@platform/event-contracts';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';
import { InAppNotificationService } from '../services/in-app.service';

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
 * Task Assigned Event interface
 */
interface TaskAssignedEvent extends IEvent {
  eventId: string | EventId;
  eventType: string;
  timestamp: string;
  payload: {
    taskId: string;
    title: string;
    tenantId: string;
    assigneeId: string;
    assignedBy?: string;
    dueDate?: string;
    priority?: string;
    description?: string;
  };
}

/**
 * Task Overdue Event interface
 */
interface TaskOverdueEvent extends IEvent {
  eventId: string | EventId;
  eventType: string;
  timestamp: string;
  payload: {
    taskId: string;
    title: string;
    tenantId: string;
    assigneeId: string;
    dueDate?: string;
    priority?: string;
  };
}

/**
 * @deprecated This handler is superseded by TaskEventHandler which handles all task events
 * (TaskCreated, TaskAssigned, TaskStatusChanged, TaskCompleted, TaskOverdue) with both
 * in-app and push notification support. This handler has been removed from the
 * NotificationModule providers to prevent duplicate notifications for TaskAssigned
 * and TaskOverdue events. See D11 audit report.
 *
 * DO NOT re-register this handler in any module. Use TaskEventHandler instead.
 *
 * Original description:
 * Listens to TaskAssigned and TaskOverdue events and creates in-app notifications.
 *
 * Backpressure: A semaphore caps the number of concurrently processed
 * task events at MAX_EVENT_CONCURRENCY.
 */
@Injectable()
export class TaskAssignedEventHandler
  implements IEventHandler<TaskAssignedEvent | TaskOverdueEvent>, OnModuleInit
{
  private readonly logger = new Logger(TaskAssignedEventHandler.name);
  private readonly semaphore = new Semaphore(MAX_EVENT_CONCURRENCY);

  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    private readonly inAppService: InAppNotificationService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // WHAT — `subscribeWildcard` builds `events.*.{eventType}`, capturing
    // every tenant's task lifecycle events.
    // WHY explicit wildcard — task notifications are cross-tenant; one
    // notification-service instance dispatches to every tenant's users.
    // Explicit helper pins the publisher↔subscriber contract (3 segments).
    await this.eventBus.subscribeWildcard('TaskAssigned', this);
    await this.eventBus.subscribeWildcard('TaskOverdue', this);
    this.logger.log('Subscribed to TaskAssigned and TaskOverdue events (cross-tenant wildcard)');
  }

  getEventType(): string {
    return 'TaskAssigned';
  }

  async handle(event: TaskAssignedEvent | TaskOverdueEvent): Promise<HandlerOutcome> {
    const { payload } = event;

    // SECURITY: Validate tenantId format to ensure data isolation
    if (!payload.tenantId || !UUID_REGEX.test(payload.tenantId)) {
      this.logger.error(
        `Task event has invalid or missing tenantId. ` +
          'Skipping to prevent cross-tenant notification leakage.',
      );
      return HandlerOutcome.terminate('Task event: missing or invalid tenantId');
    }

    // Validate required fields
    if (!payload.taskId || !payload.assigneeId || !payload.title) {
      this.logger.error(
        `Task event missing required fields (taskId, assigneeId, or title). Skipping.`,
      );
      return HandlerOutcome.terminate('Task event: missing taskId, assigneeId or title');
    }

    const eventType = event.eventType || 'TaskAssigned';

    this.logger.log(
      `Processing ${eventType} for task ${payload.taskId.substring(0, 8)}... ` +
        `in tenant ${payload.tenantId.substring(0, 8)}...`,
    );

    // Acquire semaphore slot before processing to enforce backpressure
    await this.semaphore.acquire();

    try {
      if (eventType === 'TaskOverdue') {
        await this.handleTaskOverdue(event as TaskOverdueEvent);
      } else {
        await this.handleTaskAssigned(event as TaskAssignedEvent);
      }
      return HandlerOutcome.ack();
    } catch (error) {
      this.logger.error(
        `Error processing ${eventType} event: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return outcomeForError(`${eventType} notification`, error);
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Handle TaskAssigned event - create in-app notification for the assignee
   */
  private async handleTaskAssigned(event: TaskAssignedEvent): Promise<void> {
    const { payload } = event;
    const title = `Yeni g\u00F6rev atand\u0131: ${payload.title}`;
    const body = payload.description
      ? payload.description.substring(0, 500)
      : `Size yeni bir g\u00F6rev atand\u0131: ${payload.title}`;

    await this.inAppService.createNotification(payload.tenantId, payload.assigneeId, title, body, {
      type: 'TaskAssigned',
      taskId: payload.taskId,
      assignedBy: payload.assignedBy,
      dueDate: payload.dueDate,
      priority: payload.priority,
    });

    this.logger.debug(
      `In-app notification created for TaskAssigned: task ${payload.taskId.substring(0, 8)}...`,
    );
  }

  /**
   * Handle TaskOverdue event - create in-app notification for the assignee
   */
  private async handleTaskOverdue(event: TaskOverdueEvent): Promise<void> {
    const { payload } = event;
    const title = `Gecikmi\u015F g\u00F6rev: ${payload.title}`;
    const body = `G\u00F6reviniz gecikmi\u015F durumda: ${payload.title}`;

    await this.inAppService.createNotification(payload.tenantId, payload.assigneeId, title, body, {
      type: 'TaskOverdue',
      taskId: payload.taskId,
      dueDate: payload.dueDate,
      priority: payload.priority,
    });

    this.logger.debug(
      `In-app notification created for TaskOverdue: task ${payload.taskId.substring(0, 8)}...`,
    );
  }
}
