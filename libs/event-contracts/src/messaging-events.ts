import { BaseEvent } from './base-event';
import type { LegalHoldReleasedEvent } from './compliance-events';

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
  channelId: string;
  senderId: string;
  contentType: string;
  hasAttachments: boolean;
  mentionedUserIds?: string[];
  createdAt: string;
}

/**
 * Message Read Event
 * Published when one channel message is marked as read. The logical
 * idempotency key is tenantId + messageId + messageCreatedAt + userId.
 */
export interface MessageReadEvent extends BaseEvent {
  eventType: 'MessageRead';
  channelId: string;
  messageId: string;
  messageCreatedAt: string;
  userId: string;
  readAt: string;
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

// ==================== Channel Lifecycle Events ====================
//
// ORPHAN-EVENT-CONTRACT-001..005 cure: 5 channel-lifecycle events emitted
// from apps/messaging-service/src/channel/commands/* without an interface.
// Field shapes derived from each call site's payload spread.

export interface ChannelCreatedEvent extends BaseEvent {
  eventType: 'ChannelCreated';
  channelId: string;
  channelType: string; // ChannelType enum (DIRECT/GROUP/BROADCAST/...)
  memberIds: string[];
}

export interface ChannelUpdatedEvent extends BaseEvent {
  eventType: 'ChannelUpdated';
  channelId: string;
  // Spread from `...changes` — partial fields any of which the caller
  // has updated. Field shape kept loose because update-channel.handler
  // emits whatever subset of {name, description, settings, ...} the
  // mutation touched.
  [key: string]: unknown;
}

export interface ChannelArchivedEvent extends BaseEvent {
  eventType: 'ChannelArchived';
  channelId: string;
  archivedBy: string;
}

export interface ChannelMemberAddedEvent extends BaseEvent {
  eventType: 'ChannelMemberAdded';
  channelId: string;
  userId: string;
  role: string; // ChannelMemberRole enum
  addedBy: string;
}

export interface ChannelMemberRemovedEvent extends BaseEvent {
  eventType: 'ChannelMemberRemoved';
  channelId: string;
  userId: string;
  removedBy: string;
  selfLeave: boolean;
}

// ==================== Message Lifecycle Events ====================
//
// ORPHAN-EVENT-CONTRACT-006..012 cure: 7 message-lifecycle events emitted
// from apps/messaging-service/src/message/* without an interface.

export interface MessageUpdatedEvent extends BaseEvent {
  eventType: 'MessageUpdated';
  channelId: string;
  messageId: string;
  senderId: string;
  editedAt: string | null;
}

export interface MessageDeletedEvent extends BaseEvent {
  eventType: 'MessageDeleted';
  channelId: string;
  messageId: string;
  deletedBy: string;
  deletedAt: string;
}

export interface MessagePinnedEvent extends BaseEvent {
  eventType: 'MessagePinned';
  channelId: string;
  messageId: string;
  pinnedBy: string;
}

export interface MessageUnpinnedEvent extends BaseEvent {
  eventType: 'MessageUnpinned';
  channelId: string;
  messageId: string;
  unpinnedBy: string;
}

export interface MessageForwardedEvent extends BaseEvent {
  eventType: 'MessageForwarded';
  channelId: string;
  messageId: string;
  senderId: string;
  sourceMessageId: string;
  sourceChannelId: string;
  contentType: string;
  createdAt: string;
}

export interface ReactionAddedEvent extends BaseEvent {
  eventType: 'ReactionAdded';
  channelId: string;
  messageId: string;
  userId: string;
  emoji: string;
}

export interface ReactionRemovedEvent extends BaseEvent {
  eventType: 'ReactionRemoved';
  channelId: string;
  messageId: string;
  userId: string;
  emoji: string;
}

// ==================== Compliance Events ====================
//
// ORPHAN-EVENT-CONTRACT-013..014 cure: 2 compliance events emitted from
// apps/messaging-service/src/compliance/* without an interface.

export interface RetentionPolicyChangedEvent extends BaseEvent {
  eventType: 'RetentionPolicyChanged';
  channelId: string;
  retentionDays: number;
  policyId: string;
  changedBy: string;
  changedAt: string;
}

export interface LegalHoldToggledEvent extends BaseEvent {
  eventType: 'LegalHoldToggled';
  holdId: string;
  channelId: string | null;
  activate: true;
  reason: string;
  toggledBy: string;
  toggledAt: string;
}

// ==================== Operational Events ====================
//
// ORPHAN-EVENT-CONTRACT-015..016 cure: sentiment-alert + storage-warning
// emitted from messaging-service operational paths without interface.

export interface SentimentAlertEvent extends BaseEvent {
  eventType: 'SentimentAlert';
  channelId: string;
  userId: string;
  avgScore: number;
  messageCount: number;
  detectedAt: string;
}

export interface StorageWarningEvent extends BaseEvent {
  eventType: 'StorageWarning';
  usedBytes: number;
  quotaBytes: number;
  usagePercentage: number;
  timestamp: string;
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
  | AnnouncementAcknowledgedEvent
  // ORPHAN-EVENT-CONTRACT-001..018 cure additions:
  | ChannelCreatedEvent
  | ChannelUpdatedEvent
  | ChannelArchivedEvent
  | ChannelMemberAddedEvent
  | ChannelMemberRemovedEvent
  | MessageUpdatedEvent
  | MessageDeletedEvent
  | MessagePinnedEvent
  | MessageUnpinnedEvent
  | MessageForwardedEvent
  | ReactionAddedEvent
  | ReactionRemovedEvent
  | RetentionPolicyChangedEvent
  | LegalHoldToggledEvent
  | LegalHoldReleasedEvent
  | SentimentAlertEvent
  | StorageWarningEvent;
