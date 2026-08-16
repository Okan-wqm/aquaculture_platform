import { MESSAGING_EVENT_REGISTRY, type MessagingEventType } from '../messaging-event-registry';
import {
  ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1,
  ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1,
} from '@platform/admin-http-contracts';

import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  MAX_FREE_TEXT_LENGTH,
  MAX_SHORT_CODE_LENGTH,
  UUID_SCHEMA,
} from './common.schema';

export type { MessagingEventType };

const STRING = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_SHORT_CODE_LENGTH,
} as const;

const LONG_STRING = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_FREE_TEXT_LENGTH,
} as const;

const ISO_DATE_TIME = {
  type: 'string',
  format: 'date-time',
} as const;

const LEGAL_HOLD_RELEASE_REASON_V1 = {
  type: 'string',
  minLength: ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1,
  maxLength: ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1,
} as const;

const UUID_ARRAY = {
  type: 'array',
  items: UUID_SCHEMA,
  maxItems: 1000,
} as const;

function eventSchema(
  eventType: MessagingEventType,
  properties: Record<string, unknown>,
  opts?: { allowAdditionalProperties?: boolean },
): Record<string, unknown> {
  const contract = MESSAGING_EVENT_REGISTRY[eventType];
  const required = Array.from(new Set([...BASE_EVENT_REQUIRED, ...contract.requiredPayloadFields]));
  return {
    type: 'object',
    additionalProperties: opts?.allowAdditionalProperties ?? false,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { const: eventType },
      ...properties,
    },
    required,
  } as const;
}

export const MESSAGING_EVENT_SCHEMAS = {
  ThreadCreated: eventSchema('ThreadCreated', {
    threadId: UUID_SCHEMA,
    subject: LONG_STRING,
    createdBy: UUID_SCHEMA,
    createdByRole: STRING,
  }),
  ThreadStatusChanged: eventSchema('ThreadStatusChanged', {
    threadId: UUID_SCHEMA,
    oldStatus: STRING,
    newStatus: STRING,
    changedBy: UUID_SCHEMA,
  }),
  MessageSent: eventSchema('MessageSent', {
    messageId: UUID_SCHEMA,
    channelId: UUID_SCHEMA,
    senderId: UUID_SCHEMA,
    contentType: STRING,
    hasAttachments: { type: 'boolean' },
    mentionedUserIds: { ...UUID_ARRAY, nullable: true },
    createdAt: ISO_DATE_TIME,
  }),
  MessageRead: eventSchema('MessageRead', {
    channelId: UUID_SCHEMA,
    messageId: UUID_SCHEMA,
    messageCreatedAt: ISO_DATE_TIME,
    userId: UUID_SCHEMA,
    readAt: ISO_DATE_TIME,
  }),
  BulkThreadsCreated: eventSchema('BulkThreadsCreated', {
    bulkOperationId: UUID_SCHEMA,
    tenantCount: { type: 'integer', minimum: 1, maximum: 100000 },
    subject: LONG_STRING,
    senderId: UUID_SCHEMA,
    sendEmail: { type: 'boolean' },
  }),
  AnnouncementPublished: eventSchema('AnnouncementPublished', {
    announcementId: UUID_SCHEMA,
    title: LONG_STRING,
    announcementType: STRING,
    scope: STRING,
    isGlobal: { type: 'boolean' },
    targetTenantIds: UUID_ARRAY,
    requiresAcknowledgment: { type: 'boolean' },
  }),
  AnnouncementExpired: eventSchema('AnnouncementExpired', {
    announcementId: UUID_SCHEMA,
    title: LONG_STRING,
  }),
  AnnouncementAcknowledged: eventSchema('AnnouncementAcknowledged', {
    announcementId: UUID_SCHEMA,
    userId: UUID_SCHEMA,
  }),
  ChannelCreated: eventSchema('ChannelCreated', {
    channelId: UUID_SCHEMA,
    channelType: STRING,
    memberIds: UUID_ARRAY,
  }),
  ChannelUpdated: eventSchema(
    'ChannelUpdated',
    {
      channelId: UUID_SCHEMA,
    },
    { allowAdditionalProperties: true },
  ),
  ChannelArchived: eventSchema('ChannelArchived', {
    channelId: UUID_SCHEMA,
    archivedBy: UUID_SCHEMA,
  }),
  ChannelMemberAdded: eventSchema('ChannelMemberAdded', {
    channelId: UUID_SCHEMA,
    userId: UUID_SCHEMA,
    role: STRING,
    addedBy: UUID_SCHEMA,
  }),
  ChannelMemberRemoved: eventSchema('ChannelMemberRemoved', {
    channelId: UUID_SCHEMA,
    userId: UUID_SCHEMA,
    removedBy: UUID_SCHEMA,
    selfLeave: { type: 'boolean' },
  }),
  MessageUpdated: eventSchema('MessageUpdated', {
    channelId: UUID_SCHEMA,
    messageId: UUID_SCHEMA,
    senderId: UUID_SCHEMA,
    editedAt: { anyOf: [ISO_DATE_TIME, { type: 'null' }] },
  }),
  MessageDeleted: eventSchema('MessageDeleted', {
    channelId: UUID_SCHEMA,
    messageId: UUID_SCHEMA,
    deletedBy: UUID_SCHEMA,
    deletedAt: ISO_DATE_TIME,
  }),
  MessagePinned: eventSchema('MessagePinned', {
    channelId: UUID_SCHEMA,
    messageId: UUID_SCHEMA,
    pinnedBy: UUID_SCHEMA,
  }),
  MessageUnpinned: eventSchema('MessageUnpinned', {
    channelId: UUID_SCHEMA,
    messageId: UUID_SCHEMA,
    unpinnedBy: UUID_SCHEMA,
  }),
  MessageForwarded: eventSchema('MessageForwarded', {
    channelId: UUID_SCHEMA,
    messageId: UUID_SCHEMA,
    senderId: UUID_SCHEMA,
    sourceMessageId: UUID_SCHEMA,
    sourceChannelId: UUID_SCHEMA,
    contentType: STRING,
    createdAt: ISO_DATE_TIME,
  }),
  ReactionAdded: eventSchema('ReactionAdded', {
    channelId: UUID_SCHEMA,
    messageId: UUID_SCHEMA,
    userId: UUID_SCHEMA,
    emoji: { type: 'string', minLength: 1, maxLength: 32 },
  }),
  ReactionRemoved: eventSchema('ReactionRemoved', {
    channelId: UUID_SCHEMA,
    messageId: UUID_SCHEMA,
    userId: UUID_SCHEMA,
    emoji: { type: 'string', minLength: 1, maxLength: 32 },
  }),
  RetentionPolicyChanged: eventSchema('RetentionPolicyChanged', {
    channelId: UUID_SCHEMA,
    retentionDays: { type: 'integer', minimum: 1, maximum: 36500 },
    policyId: UUID_SCHEMA,
    changedBy: UUID_SCHEMA,
    changedAt: ISO_DATE_TIME,
  }),
  LegalHoldToggled: eventSchema('LegalHoldToggled', {
    holdId: UUID_SCHEMA,
    channelId: { anyOf: [UUID_SCHEMA, { type: 'null' }] },
    activate: { const: true },
    reason: LONG_STRING,
    toggledBy: UUID_SCHEMA,
    toggledAt: ISO_DATE_TIME,
  }),
  LegalHoldReleased: {
    ...eventSchema('LegalHoldReleased', {
      version: { const: 1 },
      holdId: UUID_SCHEMA,
      scope: { type: 'string', enum: ['tenant', 'channel'] },
      resourceId: { anyOf: [UUID_SCHEMA, { type: 'null' }] },
      legalMatterId: UUID_SCHEMA,
      releaseOperationId: UUID_SCHEMA,
      releaseRequestedBy: UUID_SCHEMA,
      releaseAuthorizedBy: UUID_SCHEMA,
      releaseReason: LEGAL_HOLD_RELEASE_REASON_V1,
      releasedAtIso: ISO_DATE_TIME,
    }),
    allOf: [
      {
        if: { properties: { scope: { const: 'tenant' } } },
        then: { properties: { resourceId: { type: 'null' } } },
      },
      {
        if: { properties: { scope: { const: 'channel' } } },
        then: { properties: { resourceId: UUID_SCHEMA } },
      },
    ],
  },
  SentimentAlert: eventSchema('SentimentAlert', {
    channelId: UUID_SCHEMA,
    userId: UUID_SCHEMA,
    avgScore: { type: 'number', minimum: 0, maximum: 1 },
    messageCount: { type: 'integer', minimum: 1, maximum: 100000 },
    detectedAt: ISO_DATE_TIME,
  }),
  StorageWarning: eventSchema('StorageWarning', {
    usedBytes: { type: 'integer', minimum: 0 },
    quotaBytes: { type: 'integer', minimum: 1 },
    usagePercentage: { type: 'number', minimum: 0 },
    timestamp: ISO_DATE_TIME,
  }),
} as const;
