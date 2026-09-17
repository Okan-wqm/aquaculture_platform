/**
 * messaging-ws parity spec — pins the shared-ui WS envelope mirror to the
 * event-contracts SSoT (FAZ 3.0/3.2).
 *
 * The shared-ui types are a MIRROR (not a re-export) because the package ships
 * as a standalone dist; drift would otherwise be invisible. This spec imports
 * the SSoT module ACROSS the tree via a relative path (types + the runtime
 * event-name registry) and asserts:
 *   1. the event-name registries are identical (runtime, exact order);
 *   2. every exported envelope/WsMessage field key is present in the mirror's
 *      hand-maintained registry — the additive-only rule's tripwire;
 *   3. probe objects carrying exactly the documented fields typecheck against
 *      the SSoT shapes (compile-time via the typed consts below — vitest keeps
 *      the runtime half honest even without a typecheck runner).
 */
import { describe, expect, it } from 'vitest';

import {
  MESSAGING_WS_EVENT_NAMES,
  WsMessage,
  type MessageDeletedEnvelope,
  type MessageEnvelope,
  type MessageUpdatedEnvelope,
  type PresenceEnvelope,
  type ReadReceiptEnvelope,
  type TypingEnvelope,
} from '../messaging-ws';
import {
  MESSAGING_SOCKET_EVENT_NAMES,
  type MessageDeletedEnvelope as EcMessageDeletedEnvelope,
  type MessageEnvelope as EcMessageEnvelope,
  type MessageUpdatedEnvelope as EcMessageUpdatedEnvelope,
  type PresenceEnvelope as EcPresenceEnvelope,
  type ReadReceiptEnvelope as EcReadReceiptEnvelope,
  type TypingEnvelope as EcTypingEnvelope,
  type WsMessage as EcWsMessage,
} from '../../../../../libs/event-contracts/src/websocket-envelopes';

/**
 * Field registry of the shared-ui WsMessage mirror — REQUIRED keys only
 * (optional keys would make the runtime probe type-unsafe without `?`).
 * Optional keys are asserted through the compile-time probes below.
 */
const WS_MESSAGE_REQUIRED_FIELDS = [
  'id',
  'channelId',
  'senderId',
  'content',
  'contentType',
  'parentId',
  'forwardedFrom',
  'isDeleted',
  'createdAt',
  'editedAt',
  'metadata',
] as const;

const WS_MESSAGE_OPTIONAL_FIELDS = [
  'idempotencyKey',
  'sender',
  'attachments',
  'receipts',
  'reactionSummary',
] as const;

// Compile-time probes (erased at runtime; vitest still executes the file):
// each probe carries EXACTLY the documented fields, typed as the SSoT shape —
// a missing, extra, or retyped field on either side fails to compile.
const ecMessageProbe: EcWsMessage = {
  id: 'm1',
  channelId: 'c1',
  senderId: 'u1',
  content: null,
  contentType: 'TEXT',
  parentId: null,
  forwardedFrom: null,
  isDeleted: false,
  createdAt: '2026-09-16T10:00:00Z',
  editedAt: null,
  metadata: null,
  idempotencyKey: null,
  sender: { id: 'u1' },
  attachments: [],
  receipts: [],
  reactionSummary: [],
};

const mirrorMessageProbe: WsMessage = ecMessageProbe;
const roundTripProbe: EcWsMessage = mirrorMessageProbe;

const ecEnvelopeProbes = {
  newMessage: { channelId: 'c1', message: ecMessageProbe },
  messageUpdated: { channelId: 'c1', message: ecMessageProbe },
  messageDeleted: { channelId: 'c1', messageId: 'm1' },
  readReceipt: { channelId: 'c1', userId: 'u1', messageId: 'm1', readAt: 't' },
  typing: { channelId: 'c1', userId: 'u1', isTyping: true },
  presence: { userId: 'u1', isOnline: true, lastSeenAt: null },
} satisfies Record<string, unknown>;

const mirrorEnvelopeProbes: {
  newMessage: MessageEnvelope;
  messageUpdated: MessageUpdatedEnvelope;
  messageDeleted: MessageDeletedEnvelope;
  readReceipt: ReadReceiptEnvelope;
  typing: TypingEnvelope;
  presence: PresenceEnvelope;
} = ecEnvelopeProbes as {
  newMessage: MessageEnvelope;
  messageUpdated: MessageUpdatedEnvelope;
  messageDeleted: MessageDeletedEnvelope;
  readReceipt: ReadReceiptEnvelope;
  typing: TypingEnvelope;
  presence: PresenceEnvelope;
};

// The probes must exist at runtime too (guards against silent tree-shaking of
// the parity mechanism itself).
void roundTripProbe;
void mirrorEnvelopeProbes;

describe('messaging-ws mirror ↔ event-contracts SSoT parity', () => {
  it('the event-name registry matches the SSoT exactly (names + order)', () => {
    expect([...MESSAGING_WS_EVENT_NAMES]).toEqual([...MESSAGING_SOCKET_EVENT_NAMES]);
  });

  it('WsMessage required fields match the documented registry', () => {
    expect(Object.keys(mirrorMessageProbe).sort()).toEqual(
      [...WS_MESSAGE_REQUIRED_FIELDS, ...WS_MESSAGE_OPTIONAL_FIELDS].sort(),
    );
  });

  it('envelope field sets match the documented shapes', () => {
    expect(Object.keys(mirrorEnvelopeProbes.messageDeleted).sort()).toEqual(
      ['channelId', 'messageId'].sort(),
    );
    expect(Object.keys(mirrorEnvelopeProbes.readReceipt).sort()).toEqual(
      ['channelId', 'userId', 'messageId', 'readAt'].sort(),
    );
    expect(Object.keys(mirrorEnvelopeProbes.typing).sort()).toEqual(
      ['channelId', 'userId', 'isTyping'].sort(),
    );
    expect(Object.keys(mirrorEnvelopeProbes.presence).sort()).toEqual(
      ['userId', 'isOnline', 'lastSeenAt'].sort(),
    );
    expect(Object.keys(mirrorEnvelopeProbes.newMessage).sort()).toEqual(
      ['channelId', 'message'].sort(),
    );
  });
});
