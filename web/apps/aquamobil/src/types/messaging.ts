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
  AllMessagesSinceQuery,
  ChannelFieldsFragment,
  GetMessagesQuery,
  MessageContentType,
  MessageFieldsFragment,
  ReceiptStatus,
  ChannelMemberRole,
  NotificationPreference,
  RequestMediaUploadMutation,
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

// MOB-HIGH-022: every entity below is DERIVED from the generated operation
// result types (the `MessageFields` / `ChannelFields` fragments the read
// documents select), never re-typed by hand. A field the server drops or
// renames — or one the client used to claim that the server never sent, like
// `MessageUser.avatarUrl`/`displayName` and `Message.metadata` before
// MSG-HIGH-080 — is a compile error at the consumer, not a silent `undefined`.

/**
 * A message sender / channel member as the federated `PublicUserProfile`
 * selection delivers it. The live WS envelope carries only `{ id }` for the
 * sender; `useMessageSocket.enrichSenderFromMembers` fills the profile from the
 * cached channel members so both transports converge on this shape.
 */
export type MessageUser = NonNullable<MessageFieldsFragment['sender']>;

/** File attachment stored in MinIO via presigned upload (presigned URLs resolved server-side). */
export type MessageAttachment = MessageFieldsFragment['attachments'][number];

/** Read receipt for delivery/read tracking. */
export type MessageReceipt = NonNullable<MessageFieldsFragment['receipts']>[number];

/** Aggregated reaction summary per emoji on a message. */
export type ReactionSummary = NonNullable<MessageFieldsFragment['reactionSummary']>[number];

/**
 * Message entity — the `MessageFields` selection plus the client-only fields the
 * optimistic send pipeline and the WS envelope add.
 */
export interface Message extends MessageFieldsFragment {
  /**
   * Server idempotency key, echoed back on the `newMessage` WS envelope so the
   * client can replace its optimistic bubble with the server message instead of
   * appending a duplicate (the sender receives its own message back over the
   * channel room).
   */
  idempotencyKey?: string | null;
  /** Client-side optimistic status — not from the server. */
  _status?: MessageStatus;
  /** Client-side idempotency key — used for optimistic dedup. */
  _idempotencyKey?: string;
}

/** Channel membership with role, notification prefs, read cursor and federated profile. */
export type ChannelMember = NonNullable<ChannelFieldsFragment['members']>[number];

/**
 * Channel entity — the `ChannelFields` selection with `type` normalized to the
 * internal lowercase form at the read boundary (`normalizeChannelType`,
 * MSG-HIGH-054) and the nested message/member shapes widened to their view
 * types.
 */
export interface Channel extends Omit<ChannelFieldsFragment, 'type' | 'lastMessage' | 'members'> {
  type: ChannelType;
  /** Server-side last message preview for the channel list. */
  lastMessage: Message | null;
  /** Active members — null when the selection did not resolve them. */
  members: ChannelMember[] | null;
}

// ============================================================================
// PAGINATED RESPONSES
// ============================================================================

/** Paginated channel list from myChannels query (items type-normalized). */
export interface ChannelPage {
  items: Channel[];
  total: number;
}

/** Cursor-paginated message list from the messages query. */
export interface MessagePage extends Omit<GetMessagesQuery['messages'], 'items'> {
  items: Message[];
}

/** Media upload presigned URL response. */
export type MediaUploadResponse = RequestMediaUploadMutation['requestMediaUpload'];

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

// MOB-HIGH-022: the write payloads are the GENERATED input types — the schema
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
export interface AllMessagesSinceResponse
  extends Omit<AllMessagesSinceQuery['allMessagesSince'], 'messages'> {
  /** Messages across all channels. Field name matches backend AllMessagesSinceResponse.messages. */
  messages: Message[];
}
