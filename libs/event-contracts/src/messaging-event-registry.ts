import type { MessagingEvent } from './messaging-events';

export interface MessagingEventContract {
  readonly eventType: MessagingEvent['eventType'];
  readonly subject: `events.{tenantId}.${MessagingEvent['eventType']}`;
  readonly producer: 'messaging-service';
  readonly consumers: readonly string[];
  readonly requiredPayloadFields: readonly string[];
  readonly internalOnlyFields?: readonly string[];
  readonly websocketPublicFields?: readonly string[];
  readonly dataClass:
    | 'message'
    | 'channel'
    | 'compliance'
    | 'announcement'
    | 'thread'
    | 'operational';
}

export const MESSAGING_EVENT_REGISTRY = {
  ThreadCreated: {
    eventType: 'ThreadCreated',
    subject: 'events.{tenantId}.ThreadCreated',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'notification-service'],
    requiredPayloadFields: ['threadId', 'subject', 'createdBy', 'createdByRole'],
    dataClass: 'thread',
  },
  ThreadStatusChanged: {
    eventType: 'ThreadStatusChanged',
    subject: 'events.{tenantId}.ThreadStatusChanged',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'notification-service'],
    requiredPayloadFields: ['threadId', 'oldStatus', 'newStatus', 'changedBy'],
    dataClass: 'thread',
  },
  MessageSent: {
    eventType: 'MessageSent',
    subject: 'events.{tenantId}.MessageSent',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'notification-service', 'aquamobil'],
    requiredPayloadFields: [
      'messageId',
      'channelId',
      'senderId',
      'contentType',
      'hasAttachments',
      'createdAt',
    ],
    dataClass: 'message',
  },
  MessageRead: {
    eventType: 'MessageRead',
    subject: 'events.{tenantId}.MessageRead',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'messageId', 'messageCreatedAt', 'userId', 'readAt'],
    dataClass: 'message',
  },
  BulkThreadsCreated: {
    eventType: 'BulkThreadsCreated',
    subject: 'events.{tenantId}.BulkThreadsCreated',
    producer: 'messaging-service',
    consumers: ['notification-service'],
    requiredPayloadFields: ['bulkOperationId', 'tenantCount', 'subject', 'senderId', 'sendEmail'],
    dataClass: 'thread',
  },
  AnnouncementPublished: {
    eventType: 'AnnouncementPublished',
    subject: 'events.{tenantId}.AnnouncementPublished',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'notification-service'],
    requiredPayloadFields: [
      'announcementId',
      'title',
      'announcementType',
      'scope',
      'isGlobal',
      'targetTenantIds',
      'requiresAcknowledgment',
    ],
    dataClass: 'announcement',
  },
  AnnouncementExpired: {
    eventType: 'AnnouncementExpired',
    subject: 'events.{tenantId}.AnnouncementExpired',
    producer: 'messaging-service',
    consumers: ['gateway-api'],
    requiredPayloadFields: ['announcementId', 'title'],
    dataClass: 'announcement',
  },
  AnnouncementAcknowledged: {
    eventType: 'AnnouncementAcknowledged',
    subject: 'events.{tenantId}.AnnouncementAcknowledged',
    producer: 'messaging-service',
    consumers: ['gateway-api'],
    requiredPayloadFields: ['announcementId', 'userId'],
    dataClass: 'announcement',
  },
  ChannelCreated: {
    eventType: 'ChannelCreated',
    subject: 'events.{tenantId}.ChannelCreated',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'channelType', 'memberIds'],
    websocketPublicFields: ['channelId', 'channelType', 'memberIds'],
    dataClass: 'channel',
  },
  ChannelUpdated: {
    eventType: 'ChannelUpdated',
    subject: 'events.{tenantId}.ChannelUpdated',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId'],
    dataClass: 'channel',
  },
  ChannelArchived: {
    eventType: 'ChannelArchived',
    subject: 'events.{tenantId}.ChannelArchived',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'archivedBy'],
    dataClass: 'channel',
  },
  ChannelMemberAdded: {
    eventType: 'ChannelMemberAdded',
    subject: 'events.{tenantId}.ChannelMemberAdded',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'userId', 'role', 'addedBy'],
    dataClass: 'channel',
  },
  ChannelMemberRemoved: {
    eventType: 'ChannelMemberRemoved',
    subject: 'events.{tenantId}.ChannelMemberRemoved',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'userId', 'removedBy', 'selfLeave'],
    dataClass: 'channel',
  },
  MessageUpdated: {
    eventType: 'MessageUpdated',
    subject: 'events.{tenantId}.MessageUpdated',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'messageId', 'senderId', 'editedAt'],
    dataClass: 'message',
  },
  MessageDeleted: {
    eventType: 'MessageDeleted',
    subject: 'events.{tenantId}.MessageDeleted',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'messageId', 'deletedBy', 'deletedAt'],
    dataClass: 'message',
  },
  MessagePinned: {
    eventType: 'MessagePinned',
    subject: 'events.{tenantId}.MessagePinned',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'messageId', 'pinnedBy'],
    dataClass: 'message',
  },
  MessageUnpinned: {
    eventType: 'MessageUnpinned',
    subject: 'events.{tenantId}.MessageUnpinned',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'messageId', 'unpinnedBy'],
    dataClass: 'message',
  },
  MessageForwarded: {
    eventType: 'MessageForwarded',
    subject: 'events.{tenantId}.MessageForwarded',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: [
      'channelId',
      'messageId',
      'senderId',
      'sourceMessageId',
      'sourceChannelId',
      'contentType',
      'createdAt',
    ],
    internalOnlyFields: ['sourceMessageId', 'sourceChannelId'],
    websocketPublicFields: ['channelId', 'messageId', 'senderId', 'contentType', 'createdAt'],
    dataClass: 'message',
  },
  ReactionAdded: {
    eventType: 'ReactionAdded',
    subject: 'events.{tenantId}.ReactionAdded',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'messageId', 'userId', 'emoji'],
    dataClass: 'message',
  },
  ReactionRemoved: {
    eventType: 'ReactionRemoved',
    subject: 'events.{tenantId}.ReactionRemoved',
    producer: 'messaging-service',
    consumers: ['gateway-api', 'aquamobil'],
    requiredPayloadFields: ['channelId', 'messageId', 'userId', 'emoji'],
    dataClass: 'message',
  },
  RetentionPolicyChanged: {
    eventType: 'RetentionPolicyChanged',
    subject: 'events.{tenantId}.RetentionPolicyChanged',
    producer: 'messaging-service',
    consumers: ['messaging-service'],
    requiredPayloadFields: ['channelId', 'retentionDays', 'policyId', 'changedBy', 'changedAt'],
    dataClass: 'compliance',
  },
  LegalHoldToggled: {
    eventType: 'LegalHoldToggled',
    subject: 'events.{tenantId}.LegalHoldToggled',
    producer: 'messaging-service',
    consumers: ['messaging-service'],
    requiredPayloadFields: ['holdId', 'channelId', 'activate', 'reason', 'toggledBy', 'toggledAt'],
    dataClass: 'compliance',
  },
  LegalHoldReleased: {
    eventType: 'LegalHoldReleased',
    subject: 'events.{tenantId}.LegalHoldReleased',
    producer: 'messaging-service',
    consumers: ['messaging-service'],
    requiredPayloadFields: [
      'holdId',
      'scope',
      'resourceId',
      'legalMatterId',
      'releaseOperationId',
      'releaseRequestedBy',
      'releaseAuthorizedBy',
      'releaseReason',
      'releasedAtIso',
    ],
    dataClass: 'compliance',
  },
  SentimentAlert: {
    eventType: 'SentimentAlert',
    subject: 'events.{tenantId}.SentimentAlert',
    producer: 'messaging-service',
    consumers: ['gateway-api'],
    requiredPayloadFields: ['channelId', 'userId', 'avgScore', 'messageCount', 'detectedAt'],
    dataClass: 'operational',
  },
  StorageWarning: {
    eventType: 'StorageWarning',
    subject: 'events.{tenantId}.StorageWarning',
    producer: 'messaging-service',
    consumers: ['gateway-api'],
    requiredPayloadFields: ['usedBytes', 'quotaBytes', 'usagePercentage', 'timestamp'],
    dataClass: 'operational',
  },
} as const satisfies Record<MessagingEvent['eventType'], MessagingEventContract>;

export type MessagingEventType = keyof typeof MESSAGING_EVENT_REGISTRY;

export const MESSAGING_EVENT_TYPES = Object.keys(MESSAGING_EVENT_REGISTRY) as MessagingEventType[];

export function isMessagingEventType(eventType: string): eventType is MessagingEventType {
  return Object.prototype.hasOwnProperty.call(MESSAGING_EVENT_REGISTRY, eventType);
}

export function getMessagingEventContract(eventType: MessagingEventType): MessagingEventContract {
  return MESSAGING_EVENT_REGISTRY[eventType];
}
