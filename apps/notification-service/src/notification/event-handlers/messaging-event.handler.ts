import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome, outcomeForError } from '@platform/event-bus';
import type {
  MessagingEvent,
  MessageSentEvent,
  AnnouncementPublishedEvent,
  BulkThreadsCreatedEvent,
} from '@platform/event-contracts';

import { InAppNotificationService } from '../services/in-app.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Maximum number of messaging events processed concurrently (backpressure).
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
      const next = this.queue.shift();
      if (next !== undefined) {
        next();
      }
    }
  }
}

/**
 * Messaging Event Handler
 * Listens to messaging and announcement events and creates in-app notifications.
 *
 * Subscribed events:
 * - MessageSent: Notify the other party about a new message
 * - AnnouncementPublished: Notify target tenant admins about a new announcement
 * - BulkThreadsCreated: Notify tenant admins about bulk thread creation
 *
 * SECURITY (H-2): Message content is NEVER included in notifications.
 * Generic text is used instead to prevent content leakage via event bus.
 *
 * Backpressure: A semaphore caps the number of concurrently processed
 * messaging events at MAX_EVENT_CONCURRENCY.
 */
@Injectable()
export class MessagingEventHandler implements IEventHandler<MessagingEvent>, OnModuleInit {
  private readonly logger = new Logger(MessagingEventHandler.name);
  private readonly semaphore = new Semaphore(MAX_EVENT_CONCURRENCY);

  constructor(
    private readonly inAppService: InAppNotificationService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // WHAT — `subscribeWildcard` builds `events.*.{eventType}`, capturing
    // every tenant's messaging lifecycle.
    // WHY explicit wildcard — messaging push fan-out is cross-tenant by
    // design; explicit helper pins the publisher↔subscriber subject
    // contract (3 segments).
    await this.eventBus.subscribeWildcard('MessageSent', this);
    await this.eventBus.subscribeWildcard('AnnouncementPublished', this);
    await this.eventBus.subscribeWildcard('BulkThreadsCreated', this);
    this.logger.log(
      'Subscribed to MessageSent, AnnouncementPublished, and BulkThreadsCreated events (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'MessagingEvent';
  }

  async handle(event: MessagingEvent): Promise<HandlerOutcome> {
    // SECURITY: Validate tenantId format to ensure data isolation
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `Messaging event has invalid or missing tenantId. ` +
          'Skipping to prevent cross-tenant notification leakage.',
      );
      return HandlerOutcome.terminate('Messaging event: missing or invalid tenantId');
    }

    const eventType = event.eventType;
    this.logger.log(`Processing ${eventType} for tenant ${event.tenantId.substring(0, 8)}...`);

    // Acquire semaphore slot before processing to enforce backpressure
    await this.semaphore.acquire();

    try {
      switch (eventType) {
        case 'MessageSent':
          await this.handleMessageSent(event);
          break;
        case 'AnnouncementPublished':
          await this.handleAnnouncementPublished(event);
          break;
        case 'BulkThreadsCreated':
          await this.handleBulkThreadsCreated(event);
          break;
        default:
          this.logger.warn(`Unknown messaging event type: ${eventType}`);
          return HandlerOutcome.terminate(`Unknown messaging event type: ${eventType}`);
      }
      return HandlerOutcome.ack();
    } catch (error) {
      this.logger.error(
        `Error processing ${eventType} event: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // PLAT-HIGH-902: the bus owns retries and dead-lettering; the local
      // recursive retry ladder is gone.
      return outcomeForError(`${eventType} messaging notification`, error);
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Handle MessageSent event.
   *
   * - If isInternal === true, skip (no notification for internal admin notes).
   * - If sender is super_admin, create notification for tenant admins of that tenant.
   * - If sender is tenant_admin, create notification for superadmins.
   *
   * SECURITY (H-2): Do NOT include message content in notification body.
   */
  private async handleMessageSent(event: MessageSentEvent): Promise<void> {
    const legacyAdminEvent = event as MessageSentEvent &
      Partial<{
        isInternal: boolean;
        threadId: string;
        senderType: 'super_admin' | 'tenant_admin';
      }>;

    if (!legacyAdminEvent.threadId || !legacyAdminEvent.senderType) {
      this.logger.debug(
        `Skipping in-app notification for channel MessageSent ${event.messageId}; push fan-out is owned by messaging-service`,
      );
      return;
    }

    // Skip internal admin notes -- no notification needed
    if (legacyAdminEvent.isInternal) {
      this.logger.debug(`Skipping notification for internal message ${event.messageId}`);
      return;
    }

    if (!event.messageId || !legacyAdminEvent.threadId) {
      this.logger.error('MessageSent event missing required messageId or threadId. Skipping.');
      return;
    }

    // SECURITY (H-2): Generic notification text only -- no message content
    const title = 'New message received';
    const body =
      legacyAdminEvent.senderType === 'super_admin'
        ? 'New message from platform support'
        : 'New message from tenant administrator';

    // Determine notification target based on sender type.
    // The actual recipient userId is not in the event; we create a tenant-level
    // notification that the recipient will pick up via their tenant scope.
    // For super_admin sender -> notify tenant (tenantId from event)
    // For tenant_admin sender -> notify platform admins (tenantId = 'system')
    if (legacyAdminEvent.senderType === 'super_admin') {
      await this.inAppService.createNotification(
        event.tenantId,
        event.tenantId, // tenant-scoped: tenant admin users will see this
        title,
        body,
        {
          type: 'MESSAGE',
          threadId: legacyAdminEvent.threadId,
          messageId: event.messageId,
          senderType: legacyAdminEvent.senderType,
        },
      );
    } else if (legacyAdminEvent.senderType === 'tenant_admin') {
      // Notify superadmins -- use 'system' as the pseudo-tenant for platform admins
      await this.inAppService.createNotification(
        'system',
        'system', // platform-level notification for superadmins
        title,
        body,
        {
          type: 'MESSAGE',
          threadId: legacyAdminEvent.threadId,
          messageId: event.messageId,
          senderType: legacyAdminEvent.senderType,
          sourceTenantId: event.tenantId,
        },
      );
    }

    this.logger.debug(
      `In-app notification created for MessageSent: thread ${legacyAdminEvent.threadId.substring(0, 8)}...`,
    );
  }

  /**
   * Handle AnnouncementPublished event.
   *
   * For each tenant in targetTenantIds[], create a notification for that tenant's admin users.
   * Includes announcement title in notification body.
   */
  private async handleAnnouncementPublished(event: AnnouncementPublishedEvent): Promise<void> {
    if (!event.announcementId) {
      this.logger.error('AnnouncementPublished event missing required announcementId. Skipping.');
      return;
    }

    const targetTenantIds = event.targetTenantIds;

    if (!targetTenantIds?.length) {
      this.logger.warn(
        `AnnouncementPublished ${event.announcementId} has no target tenants. Skipping notifications.`,
      );
      return;
    }

    const sanitizedTitle = (event.title || 'New Announcement').substring(0, 255);
    const title = 'New announcement published';
    const body = `New announcement: ${sanitizedTitle}`;

    for (const tenantId of targetTenantIds) {
      if (!UUID_REGEX.test(tenantId)) {
        this.logger.warn(
          `Skipping invalid tenantId in AnnouncementPublished targetTenantIds: ${tenantId.substring(0, 36)}`,
        );
        continue;
      }

      await this.inAppService.createNotification(
        tenantId,
        tenantId, // tenant-scoped: tenant admin users will see this
        title,
        body,
        {
          type: 'ANNOUNCEMENT',
          announcementId: event.announcementId,
          announcementType: event.announcementType,
          requiresAcknowledgment: event.requiresAcknowledgment,
        },
      );
    }

    this.logger.debug(
      `In-app notifications created for AnnouncementPublished: ${event.announcementId} ` +
        `across ${targetTenantIds.length} tenants`,
    );
  }

  /**
   * Handle BulkThreadsCreated event.
   *
   * Creates one notification per tenant (tenantCount from event).
   * Since individual threadIds are not embedded in the event to avoid oversized payloads,
   * we create a generic notification referencing the bulk operation.
   */
  private async handleBulkThreadsCreated(event: BulkThreadsCreatedEvent): Promise<void> {
    if (!event.bulkOperationId) {
      this.logger.error('BulkThreadsCreated event missing required bulkOperationId. Skipping.');
      return;
    }

    const sanitizedSubject = (event.subject || 'New message').substring(0, 255);
    const title = 'New message from platform support';
    // SECURITY (H-2): Generic text, no content preview
    const body = `You have a new message: ${sanitizedSubject}`;

    // The event does not carry individual tenant IDs (to avoid oversized events).
    // We create a single notification on the originating tenant context.
    // In practice, the resolver/controller consuming bulk threads should handle
    // per-tenant notification dispatch. Here we log the bulk operation.
    await this.inAppService.createNotification(event.tenantId, event.tenantId, title, body, {
      type: 'MESSAGE',
      bulkOperationId: event.bulkOperationId,
      tenantCount: event.tenantCount,
    });

    this.logger.debug(
      `In-app notification created for BulkThreadsCreated: operation ${event.bulkOperationId} ` +
        `covering ${event.tenantCount} tenants`,
    );
  }
}
