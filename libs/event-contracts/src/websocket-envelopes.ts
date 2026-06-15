// ============================================================================
// WebSocket Wire Envelopes — Single Source of Truth for messaging Socket.IO payloads
// ============================================================================
//
// WHY this file exists (MSG-CRITICAL-050 / MSG-HIGH-050 / MSG-MEDIUM-050/051 root cause):
//   The NATS domain events (MessageSentEvent, MessageReadEvent, … in
//   messaging-events.ts) are intentionally THIN per ADR-006 — they carry only
//   IDs + metadata, never the full message body. The gateway NATS→Socket.IO
//   bridge previously emitted those thin events VERBATIM (flat `{ messageId, … }`),
//   but the AquaMobil client reads `event.message` (a full hydrated Message).
//   The shapes disagreed, so live message delivery, edits, read-receipts, and
//   deletes silently failed on the client.
//
// WHAT this fixes:
//   This module is the ONE authoritative definition of every payload the gateway
//   emits over the `/messaging` Socket.IO namespace. The bridge HYDRATES each
//   thin NATS event into the matching envelope here (fetching the full Message
//   from messaging-service via the GetMessageForBroadcast NATS request) before
//   emitting. The client parses exactly these shapes.
//
// SSoT obligation:
//   web/apps/aquamobil/src/types/messaging.ts mirrors these envelope shapes
//   (the standalone PWA bundle cannot import @platform/event-contracts directly).
//   The two MUST stay field-for-field identical; the parity is asserted by
//   apps/gateway-api/src/websocket/__tests__/ws-envelope-contract.spec.ts and is
//   the wire-contract half of the Phase-1 messaging-live fix.
//
// @see ADR-006 (flat event-contract pattern — why the bridge must hydrate)
// @see ADR-012 (messaging service)
// ============================================================================

// ----------------------------------------------------------------------------
// Hydrated entity shapes (post-resolution; what the client renders)
// ----------------------------------------------------------------------------

/**
 * Content type drives client message rendering (text bubble, image, file card…).
 *
 * WIRE FORM = the GraphQL enum NAME (UPPERCASE), NOT the lowercase persisted DB
 * value. The live WS path (gateway hydrator) and the GraphQL query path MUST
 * agree on one wire form for `contentType`; the GraphQL `MessageContentType`
 * enum serializes its NAME, so the WS hydrator projects the DB value → NAME via
 * `toWireEnumName` (S1-CODEGEN). This union is field-for-field identical to the
 * generated `MessageContentType` graphql-codegen union the AquaMobil client now
 * consumes.
 */
export type WsMessageContentType = 'TEXT' | 'IMAGE' | 'FILE' | 'VOICE' | 'SYSTEM';

/**
 * Read/delivery receipt status — GraphQL enum NAME (UPPERCASE) wire form, see
 * {@link WsMessageContentType}. Identical to the generated `ReceiptStatus` union.
 */
export type WsReceiptStatus = 'DELIVERED' | 'READ';

/**
 * Federation-resolved sender/member identity. Hydrated from auth-service
 * (the user-identity SSoT) — never a placeholder. `firstName/lastName` OR
 * `displayName` may be present depending on the resolver; clients fall back
 * across them.
 */
export interface WsMessageUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  displayName?: string | null;
  profileImageUrl?: string | null;
  avatarUrl?: string | null;
  isOnline?: boolean;
  lastSeenAt?: string | null;
}

/** Attachment with presigned URLs resolved at hydration time (never null-by-default). */
export interface WsMessageAttachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  thumbnailUrl?: string | null;
  downloadUrl?: string | null;
}

/** Per-user delivery/read receipt. */
export interface WsMessageReceipt {
  userId: string;
  status: WsReceiptStatus;
  deliveredAt: string | null;
  readAt: string | null;
}

/** Aggregated emoji reaction counts on a message. */
export interface WsReactionSummary {
  emoji: string;
  count: number;
  userIds: string[];
  hasReacted: boolean;
}

/**
 * Fully-hydrated message — the body the client inserts directly into its
 * message cache on a live `newMessage`/`messageUpdated` event. Mirrors the
 * AquaMobil `Message` interface (minus the client-only `_status`/`_idempotencyKey`,
 * which the client manages locally). `idempotencyKey` is included so the client
 * can dedup the server echo against its optimistic bubble (MSG-MEDIUM-003 class).
 */
export interface WsMessage {
  id: string;
  channelId: string;
  senderId: string;
  content: string | null;
  contentType: WsMessageContentType;
  parentId: string | null;
  forwardedFrom: string | null;
  isDeleted: boolean;
  createdAt: string;
  editedAt: string | null;
  metadata: Record<string, unknown> | null;
  /** Stable client idempotency key echoed back so optimistic sends dedup. */
  idempotencyKey?: string | null;
  sender?: WsMessageUser;
  attachments?: WsMessageAttachment[];
  receipts?: WsMessageReceipt[];
  reactionSummary?: WsReactionSummary[];
}

// ----------------------------------------------------------------------------
// Socket.IO event envelopes (gateway → client)
// ----------------------------------------------------------------------------

/** `newMessage` — a message arrived in a channel the socket has joined. */
export interface MessageEnvelope {
  channelId: string;
  message: WsMessage;
}

/** `messageUpdated` — an existing message was edited (full hydrated body). */
export interface MessageUpdatedEnvelope {
  channelId: string;
  message: WsMessage;
}

/** `messageDeleted` — a message was (soft-)deleted. Carries channelId so the client targets the right cache key. */
export interface MessageDeletedEnvelope {
  channelId: string;
  messageId: string;
}

/**
 * `readReceipt` — a member advanced their read cursor. Field is `readAt`
 * (ISO timestamp), NOT `timestamp` — the previous mismatch left the client
 * with `readAt: undefined` (MSG-HIGH-050).
 */
export interface ReadReceiptEnvelope {
  channelId: string;
  userId: string;
  messageId: string;
  readAt: string;
}

/**
 * `typing` — a member started/stopped typing. The `isTyping` boolean is
 * relayed from the sender; the previous gateway dropped it (MSG-HIGH-050),
 * so remote indicators never showed.
 */
export interface TypingEnvelope {
  channelId: string;
  userId: string;
  isTyping: boolean;
}

/**
 * `presence` — a member came online / went offline. Field is `isOnline`
 * (boolean), NOT `status:'online'|'offline'` (MSG-MEDIUM-051).
 */
export interface PresenceEnvelope {
  userId: string;
  isOnline: boolean;
  lastSeenAt: string | null;
}

/**
 * Canonical map of Socket.IO event name → emitted envelope type. Both the
 * gateway emit sites and the client handlers key off these names; the
 * contract test asserts the gateway never emits a name outside this map.
 */
export interface MessagingSocketEventMap {
  newMessage: MessageEnvelope;
  messageUpdated: MessageUpdatedEnvelope;
  messageDeleted: MessageDeletedEnvelope;
  readReceipt: ReadReceiptEnvelope;
  typing: TypingEnvelope;
  presence: PresenceEnvelope;
}

/** Socket.IO event names the `/messaging` namespace emits to clients. */
export const MESSAGING_SOCKET_EVENT_NAMES = [
  'newMessage',
  'messageUpdated',
  'messageDeleted',
  'readReceipt',
  'typing',
  'presence',
] as const;

export type MessagingSocketEventName = (typeof MESSAGING_SOCKET_EVENT_NAMES)[number];

// ----------------------------------------------------------------------------
// Bridge ↔ messaging-service hydration contract (NATS request-reply)
// ----------------------------------------------------------------------------

/**
 * NATS request subject the gateway bridge calls to hydrate a thin
 * MessageSent/MessageUpdated/MessageForwarded event into a full {@link WsMessage}
 * before broadcasting. Tenant-scoped: the responder resolves the message only
 * within `tenantId` (defence-in-depth against a compromised bridge).
 */
export const GET_MESSAGE_FOR_BROADCAST_SUBJECT = 'request.messaging.getMessageForBroadcast';

/** Request payload for {@link GET_MESSAGE_FOR_BROADCAST_SUBJECT}. */
export interface GetMessageForBroadcastRequest {
  tenantId: string;
  channelId: string;
  messageId: string;
}

/**
 * Response payload. `message` is null when the message is not found within the
 * tenant (the bridge then drops the broadcast rather than emitting an empty
 * envelope the client would choke on).
 */
export interface GetMessageForBroadcastResponse {
  message: WsMessage | null;
}
