// ============================================================================
// Messaging Type Definitions — Frontend mirrors of messaging-service GraphQL types
// ============================================================================

/**
 * WHY: Frontend type mirrors of the backend Channel, ChannelMember, Message,
 * MessageAttachment, MessageReceipt, and related GraphQL ObjectTypes from
 * messaging-service. Keeping a dedicated file prevents messaging types from
 * polluting the main types/index.ts and enables tree-shaking when the messaging
 * feature is not yet activated for a tenant.
 *
 * @see ADR-012 (Messaging Service)
 */

// ============================================================================
// ENUMS
// ============================================================================
//
// S1-CODEGEN: schema-owned enums whose READ wire form is the UPPERCASE GraphQL
// enum NAME are re-exported from the generated client contract so the casing can
// never drift from the supergraph. `MessageContentType`, `ReceiptStatus`,
// `ChannelMemberRole`, and `NotificationPreference` are all value-mapped enums
// registered with a METADATA-ONLY valuesMap (descriptions only — NestJS
// `EnumMetadataValuesMapOptions` rejects a `value` override, INFRA-CRITICAL-014),
// so graphql-js serializes the UPPERCASE NAME on the read path (`'TEXT'`,
// `'DELIVERED'`, `'OWNER'`, `'ALL'`). The WS hydrator projects the lowercase DB
// VALUE → that same NAME (toWireEnumName), so the GraphQL query path AND the live
// WS path emit one wire form; every client comparison is migrated to UPPERCASE in
// lock-step (ChatRoomPage / MessageBubble / ForwardModal / ChannelSettingsPage /
// MentionPicker / MemberRow / useChannelActions). The WRITE path normalizes the
// inbound NAME back to the DB VALUE at the resolver input boundary
// (normalizeEnumInput in apps/messaging-service/src/shared/enum-wire.util.ts).
//
// `ChannelType` is the ONE exception NOT re-exported from generated: it keeps its
// dedicated lowercase internal form + `ChannelTypeWire` wire form because it has a
// deliberate client-side read/write codec boundary (utils/channel-type-wire.ts,
// MSG-HIGH-054) rather than a per-comparison UPPERCASE migration.

import type {
  MessageContentType,
  ReceiptStatus,
  ChannelMemberRole,
  NotificationPreference,
} from '@/generated/graphql';

export type {
  MessageContentType,
  ReceiptStatus,
  ChannelMemberRole,
  NotificationPreference,
};

/** Channel type determines UI layout and membership rules (internal lowercase form). */
export type ChannelType = 'direct' | 'group' | 'ai';

/**
 * GraphQL wire KEYs for `ChannelType` — the literals the messaging subgraph
 * enum actually accepts on the wire. The messaging-service registers
 * `ChannelType` WITHOUT a valuesMap, so graphql-js exposes the enum KEYs
 * (`DIRECT`/`GROUP`/`AI`), not the lowercase persisted values. The runtime
 * codec mapping internal <-> wire lives in {@link ../utils/channel-type-wire}.
 *
 * ChannelType keeps its dedicated lowercase internal form because of that
 * read/write normalization boundary; `ChannelMemberRole`/`NotificationPreference`
 * (above) have NO such boundary, so they take the generated UPPERCASE GraphQL
 * enum NAME directly — the wire form the value-mapped messaging enums emit and
 * accept (same class as MessageContentType, S1-CODEGEN).
 */
export type ChannelTypeWire = 'DIRECT' | 'GROUP' | 'AI';

/** Optimistic message status for the send pipeline. */
export type MessageStatus = 'pending' | 'sent' | 'failed';

// ============================================================================
// ENTITIES
// ============================================================================

/**
 * Federation-compatible user entity for message sender resolution.
 * WHY: The messaging-service extends the auth-service User type via federation.
 * The GraphQL response may include firstName/lastName OR displayName depending
 * on the resolver. We support both shapes for forward compatibility.
 */
export interface MessageUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  // email intentionally absent: a message sender / channel member is a
  // PublicUserProfile (display-only) — email never crosses the federated
  // reference. Use firstName/lastName for names.
  displayName?: string | null;
  profileImageUrl?: string | null;
  avatarUrl?: string | null;
  isOnline?: boolean;
  lastSeenAt?: string | null;
}

/**
 * Channel entity — represents a messaging channel (DIRECT, GROUP, or AI).
 * DIRECT channels have exactly 2 members and no name.
 * AI channels may have an aiPersona and aiServiceUrl for persona-based routing.
 */
export interface Channel {
  id: string;
  type: ChannelType;
  name: string | null;
  description: string | null;
  avatarUrl: string | null;
  createdBy: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  /** AI persona ID for AI channels (e.g. 'expert-v1'). Null = general AI chat. */
  aiPersona?: string | null;
  /** Custom MCP server URL override. Null = default ai-service via NATS. */
  aiServiceUrl?: string | null;
  /** Populated via field resolver — active members of this channel. */
  members?: ChannelMember[];
  /** Server-computed member count. */
  memberCount?: number;
  /** Server-side last message preview for channel list. */
  lastMessage?: Message | null;
  /** Server-side or client-enriched unread count. */
  unreadCount?: number;
}

/**
 * Channel membership with role, notification prefs, and read cursor.
 */
export interface ChannelMember {
  id: string;
  channelId: string;
  userId: string;
  role: ChannelMemberRole;
  notificationPreference: NotificationPreference;
  lastReadAt: string | null;
  joinedAt: string;
  leftAt: string | null;
  /** Populated via federation — user details for member list UI. */
  user?: MessageUser;
}

/**
 * Message entity with composite PK (id, createdAt) for partition routing.
 */
export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  content: string | null;
  contentType: MessageContentType;
  parentId: string | null;
  forwardedFrom: string | null;
  isDeleted: boolean;
  createdAt: string;
  editedAt: string | null;
  metadata: Record<string, unknown> | null;
  /**
   * Server idempotency key, echoed back on the `newMessage` WS envelope so the
   * client can replace its optimistic bubble with the server message instead of
   * appending a duplicate (the sender receives its own message back over the
   * channel room).
   */
  idempotencyKey?: string | null;
  /** Populated via field resolver. */
  sender?: MessageUser;
  /** Populated via field resolver. */
  attachments?: MessageAttachment[];
  /** Populated via field resolver. */
  receipts?: MessageReceipt[];
  /** Aggregated reaction counts per emoji. */
  reactionSummary?: ReactionSummary[];
  /** Client-side optimistic status — not from the server. */
  _status?: MessageStatus;
  /** Client-side idempotency key — used for optimistic dedup. */
  _idempotencyKey?: string;
}

/**
 * File attachment stored in MinIO via presigned upload.
 */
export interface MessageAttachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** Presigned thumbnail URL for images/videos. */
  thumbnailUrl?: string | null;
  /** Presigned download URL — resolved by field resolver on backend. */
  downloadUrl?: string | null;
}

/**
 * Read receipt for delivery/read tracking.
 */
export interface MessageReceipt {
  userId: string;
  status: ReceiptStatus;
  deliveredAt: string | null;
  readAt: string | null;
}

/**
 * Aggregated reaction summary per emoji on a message.
 */
export interface ReactionSummary {
  emoji: string;
  count: number;
  userIds: string[];
  hasReacted: boolean;
}

// ============================================================================
// PAGINATED RESPONSES
// ============================================================================

/** Paginated channel list from myChannels query. */
export interface ChannelPage {
  items: Channel[];
  total: number;
}

/** Cursor-paginated message list from messages query. */
export interface MessagePage {
  items: Message[];
  hasMore: boolean;
  cursor: string | null;
}

/** Media upload presigned URL response. */
export interface MediaUploadResponse {
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
}

// ============================================================================
// SOCKET.IO EVENT PAYLOADS
// ============================================================================

/** Payload emitted on 'newMessage' socket event. */
export interface NewMessageEvent {
  channelId: string;
  message: Message;
}

/** Payload emitted on 'messageUpdated' socket event. */
export interface MessageUpdatedEvent {
  channelId: string;
  message: Message;
}

/** Payload emitted on 'messageDeleted' socket event. */
export interface MessageDeletedEvent {
  channelId: string;
  messageId: string;
}

/** Payload emitted on 'typing' socket event. */
export interface TypingEvent {
  channelId: string;
  userId: string;
  isTyping: boolean;
}

/** Payload emitted on 'presence' socket event. */
export interface PresenceEvent {
  userId: string;
  isOnline: boolean;
  lastSeenAt: string | null;
}

/** Payload emitted on 'readReceipt' socket event. */
export interface ReadReceiptEvent {
  channelId: string;
  userId: string;
  messageId: string;
  readAt: string;
}

// ============================================================================
// INPUT TYPES — match ADR-012 section 6.2 GraphQL Input types
// ============================================================================

// MOB-HIGH-019: the write payloads are the GENERATED input types — the schema
// is the SSoT, not a hand-maintained mirror. `CreateChannelInput.type` is the
// generated `ChannelType` enum union (the SDL KEYS 'DIRECT' | 'GROUP' | 'AI'),
// which is what makes posting the lowercase internal value a compile error
// (MSG-HIGH-054) — callers go through `toWireChannelType`.
export type {
  CreateChannelInput,
  RequestMediaUploadInput,
  SendMessageInput,
} from '../generated/graphql';

/**
 * AI persona definition returned by the availableAiPersonas query.
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */
export interface AiPersona {
  /** Persona ID matching ai-service persona IDs. Null = general AI assistant. */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Short description of persona specialization. */
  description: string;
  /** Icon identifier for frontend rendering (Lucide icon name). */
  icon: string;
  /** Theme color key for UI styling. */
  color: string;
  /** List of capability labels. */
  capabilities?: string[];
}

// ============================================================================
// AGGREGATED REACTION TYPE — alias for consumers expecting MessageReaction name
// ============================================================================

/** Alias for ReactionSummary -- some consumers may use this name per ADR-012. */
export type MessageReaction = ReactionSummary;

// ============================================================================
// SOCKET.IO EVENT ALIASES — ADR-012 naming convention
// ============================================================================

/** Socket event for a new message -- alias for NewMessageEvent. */
export type SocketNewMessageEvent = NewMessageEvent;

/** Socket event for typing indicator -- alias for TypingEvent. */
export type SocketTypingEvent = TypingEvent;

/** Socket event for presence change -- alias for PresenceEvent. */
export type SocketPresenceEvent = PresenceEvent;

// ============================================================================
// BULK SYNC RESPONSE — ADR-012 H7 offline sync
// ============================================================================

/**
 * Response for allMessagesSince bulk offline sync (H7).
 * Returns messages across all channels, capped at 50 per channel within the global limit.
 */
export interface AllMessagesSinceResponse {
  /** Messages across all channels. Field name matches backend AllMessagesSinceResponse.messages. */
  messages: Message[];
  /** True if more messages exist beyond the limit. */
  hasMore: boolean;
  /** Opaque token for continuation paging. Pass back as syncToken. */
  syncToken: string | null;
}
