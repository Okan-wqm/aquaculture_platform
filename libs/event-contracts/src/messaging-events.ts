import { BaseEvent } from './base-event';

// ==================== Thread Events ====================

/**
 * Thread Created Event
 * Published when a new messaging thread is created.
 */
export interface ThreadCreatedEvent extends BaseEvent {
  eventType: 'ThreadCreated';
  threadId: string;
  subject: string;
  createdBy: string;
  createdByRole: string;
}

/**
 * Thread Status Changed Event
 * Published when a thread's status transitions (e.g. open -> closed).
 */
export interface ThreadStatusChangedEvent extends BaseEvent {
  eventType: 'ThreadStatusChanged';
  threadId: string;
  oldStatus: string;
  newStatus: string;
  changedBy: string;
}

// ==================== Message Events ====================

/**
 * Message Sent Event
 * Published when a message is sent within a thread.
 *
 * NOTE: contentPreview is intentionally omitted — security review flagged
 * content leakage risk via event bus. Notification-service should fetch
 * content on-demand if needed.
 */
export interface MessageSentEvent extends BaseEvent {
  eventType: 'MessageSent';
  messageId: string;
  threadId: string;
  senderId: string;
  senderType: string;
  senderName: string;
  isInternal: boolean;
}

/**
 * Message Read Event
 * Published when one or more messages in a thread are marked as read.
 */
export interface MessageReadEvent extends BaseEvent {
  eventType: 'MessageRead';
  threadId: string;
  readBy: string;
  readByRole: string;
  messageIds: string[];
}

// ==================== Bulk Operations ====================

/**
 * Bulk Threads Created Event
 * Published when threads are created in bulk (e.g. admin broadcast).
 * Only carries the bulkOperationId — individual threadIds are NOT embedded
 * to avoid oversized events.
 */
export interface BulkThreadsCreatedEvent extends BaseEvent {
  eventType: 'BulkThreadsCreated';
  bulkOperationId: string;
  tenantCount: number;
  subject: string;
  senderId: string;
  sendEmail: boolean;
}

// ==================== Announcement Events ====================

/**
 * Announcement Published Event
 * Published when an announcement is made available to its target audience.
 */
export interface AnnouncementPublishedEvent extends BaseEvent {
  eventType: 'AnnouncementPublished';
  announcementId: string;
  title: string;
  announcementType: string;
  scope: string;
  isGlobal: boolean;
  targetTenantIds: string[];
  requiresAcknowledgment: boolean;
}

/**
 * Announcement Expired Event
 * Published when an announcement passes its expiration date.
 */
export interface AnnouncementExpiredEvent extends BaseEvent {
  eventType: 'AnnouncementExpired';
  announcementId: string;
  title: string;
}

/**
 * Announcement Acknowledged Event
 * Published when a user acknowledges an announcement.
 */
export interface AnnouncementAcknowledgedEvent extends BaseEvent {
  eventType: 'AnnouncementAcknowledged';
  announcementId: string;
  userId: string;
}

// ==================== Type Union ====================

/**
 * Union type for all messaging events
 */
export type MessagingEvent =
  | ThreadCreatedEvent
  | ThreadStatusChangedEvent
  | MessageSentEvent
  | MessageReadEvent
  | BulkThreadsCreatedEvent
  | AnnouncementPublishedEvent
  | AnnouncementExpiredEvent
  | AnnouncementAcknowledgedEvent;
