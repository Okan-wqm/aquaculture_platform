/**
 * WS→panel message projection + shared comparison keys (FAZ 3.2/3.3).
 *
 * The live WS envelope (WsMessage, re-exported from @aquaculture/shared-ui)
 * is the server-authoritative body, but the panel's Message type is the shape
 * every cache and component reads. This module is the ONE place the wire body
 * is projected into the cache shape — pure, unit-tested, no React.
 *
 * V1'A2 (sender enrichment) happens at the WsMessage level BEFORE projection:
 * enrichWsSenderFromChannels() resolves the id-only wire sender against the
 * channels cache's Channel.members[].user so a live message never renders as
 * the generic 'Member' fallback.
 */
import type { WsMessage, WsMessageUser } from '@aquaculture/shared-ui';

import type { Channel, Message, MessagingUser } from '../types/messaging';

/** The backend's AI virtual user (FAZ 2 contract; matches aquamobil's AI_USER_ID). */
export const AI_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Resolve the id-only wire sender against the channels cache members.
 *
 * The gateway's live path carries `sender: { id }` only (no-PII oracle — the
 * bridge never broadcasts display PII to channel rooms). The channels cache IS
 * authorized to hold federation-resolved names (myChannels → members.user), so
 * the display name is resolved CLIENT-side from it — the wire stays PII-free.
 * No-op when the sender already carries display fields, or when the member is
 * unknown (channel not in cache): the message still renders, and the next
 * GraphQL fetch supplies the name.
 */
export function enrichWsSenderFromChannels(
  channels: Channel[] | undefined,
  message: WsMessage,
): WsMessage {
  if (
    message.sender?.firstName ||
    message.sender?.lastName ||
    message.sender?.displayName
  ) {
    return message;
  }
  const channel = channels?.find((c) => c.id === message.channelId);
  const member = channel?.members?.find((m) => m.userId === message.senderId);
  if (!member?.user) return message;
  const enriched: WsMessageUser = {
    ...member.user,
    id: message.senderId,
  };
  return { ...message, sender: enriched };
}

/**
 * Project the wire message into the panel cache shape.
 *
 * `isAiGenerated` is NOT on the wire envelope — the senderId === AI_USER_ID
 * server-authoritative secondary signal stands in (the FAZ 2 contract's
 * sanctioned pair: isAiGenerated ∨ senderId === AI_USER_ID; metadata.isAi is
 * user-forgeable and never consulted).
 */
export function projectWsMessage(ws: WsMessage): Message {
  return {
    id: ws.id,
    channelId: ws.channelId,
    senderId: ws.senderId,
    content: ws.content,
    contentType: ws.contentType,
    isDeleted: ws.isDeleted,
    isAiGenerated: ws.senderId === AI_USER_ID,
    createdAt: ws.createdAt,
    editedAt: ws.editedAt,
    metadata: ws.metadata ?? null,
    // Panel messages are per-thread rows; the temp-row dedupe key rides along
    // so a live echo of MY OWN optimistic send replaces its temp bubble.
    idempotencyKey: ws.idempotencyKey ?? null,
    sender: projectWsSender(ws.sender),
  };
}

function projectWsSender(sender: WsMessageUser | undefined): MessagingUser | null {
  if (!sender) return null;
  return {
    id: sender.id,
    firstName: sender.firstName ?? sender.displayName ?? null,
    lastName: sender.lastName ?? null,
    profileImageUrl: sender.profileImageUrl ?? sender.avatarUrl ?? null,
  };
}
