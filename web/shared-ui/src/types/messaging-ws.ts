/**
 * Messaging WebSocket envelope types — the WEB-side mirror of the gateway's
 * `/messaging` Socket.IO wire contract (SSoT: libs/event-contracts/src/
 * websocket-envelopes.ts + the direct emits in apps/gateway-api/src/websocket/
 * messaging.gateway.ts).
 *
 * WHY a mirror instead of a re-export: shared-ui ships as a standalone dist
 * package (Module Federation singleton); a type-only re-export of the
 * monorepo lib would emit a relative declaration path that does not exist for
 * dist consumers. The field-for-field parity is therefore pinned by
 * src/types/__tests__/messaging-ws.spec.ts, which imports the SSoT module
 * across the tree and asserts the event-name registry at runtime.
 *
 * ADDITIVE-ONLY: fields are never removed or retyped; new fields must be
 * optional (see agent-workspace/ws-event-contract.md — the B↔F contract this
 * mirror belongs to).
 */

// ----------------------------------------------------------------------------
// Hydrated entity shapes (mirror of the event-contracts SSoT)
// ----------------------------------------------------------------------------

/** Content type wire form = GraphQL enum NAME (UPPERCASE), never the DB value. */
export type WsMessageContentType = 'TEXT' | 'IMAGE' | 'FILE' | 'VOICE' | 'SYSTEM';

/** Receipt status wire form = GraphQL enum NAME (UPPERCASE). */
export type WsReceiptStatus = 'DELIVERED' | 'READ';

/**
 * Federation-resolved sender/member identity. The live WS path carries
 * `sender: { id }` only in practice (no-PII oracle) — clients enrich display
 * fields from their own member caches (V1'A2 sender enrichment).
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

/** Attachment with presigned URLs resolved at hydration time. */
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

/** Fully-hydrated message — the body a client merges into its message cache. */
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
// Gateway → client event envelopes
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

/** `messageDeleted` — soft-delete; the body is deliberately NOT carried. */
export interface MessageDeletedEnvelope {
  channelId: string;
  messageId: string;
}

/** `readReceipt` — a member advanced their read cursor (persistent path). */
export interface ReadReceiptEnvelope {
  channelId: string;
  userId: string;
  messageId: string;
  readAt: string;
}

/** `typing` — a member started/stopped typing. */
export interface TypingEnvelope {
  channelId: string;
  userId: string;
  isTyping: boolean;
}

/** `presence` — a member came online / went offline (tenant-wide). */
export interface PresenceEnvelope {
  userId: string;
  isOnline: boolean;
  lastSeenAt: string | null;
}

// The events below are emitted DIRECTLY by the gateway (not via the NATS
// bridge hydration path), so the event-contracts SSoT does not carry their
// shapes — this mirror is their typed definition for web consumers.

/** `messageSyncHint` — content-free "refetch this channel" hint (MSG-HIGH-063). */
export interface MessageSyncHintEnvelope {
  channelId: string;
}

/** `channelEvent` — channel lifecycle (created / member added-removed / …). */
export interface ChannelEventEnvelope {
  channelId: string;
  eventType: string;
  userId?: string;
}

/** `channelMemberRemoved` — the targeted user's sockets were evicted from the room. */
export interface ChannelMemberRemovedEnvelope {
  tenantId: string;
  channelId: string;
  userId: string;
  timestamp: string;
}

/** `reAuth` — the server requests a fresh token; answer with `reAuthResponse`. */
export interface ReAuthEnvelope {
  message: string;
  timestamp: string;
}

/** `connected` — informational confirmation after handleConnection. */
export interface ConnectedEnvelope {
  message: string;
  userId: string;
  tenantId: string;
}

/** `error` — handshake/authorization failure; `code` when the gateway sends one. */
export interface SocketIoErrorEnvelope {
  message: string;
  code?: number;
}

// ----------------------------------------------------------------------------
// Event-name registry (runtime mirror of MESSAGING_SOCKET_EVENT_NAMES)
// ----------------------------------------------------------------------------

/**
 * The six bridge-hydrated event names, in the SSoT's declaration order.
 * Parity with event-contracts is asserted at runtime by the mirror spec —
 * keep BOTH lists in sync (or the spec fails).
 */
export const MESSAGING_WS_EVENT_NAMES = [
  'newMessage',
  'messageUpdated',
  'messageDeleted',
  'readReceipt',
  'typing',
  'presence',
] as const;

export type MessagingWsEventName = (typeof MESSAGING_WS_EVENT_NAMES)[number];

/** Gateway-direct event names (beyond the bridge registry above). */
export const MESSAGING_WS_DIRECT_EVENT_NAMES = [
  'messageSyncHint',
  'channelEvent',
  'channelMemberRemoved',
  'reAuth',
  'connected',
  'error',
] as const;

export type MessagingWsDirectEventName = (typeof MESSAGING_WS_DIRECT_EVENT_NAMES)[number];
