/** Panel messaging domain types — mirror the messaging subgraph schema. */

export type ChannelType = 'DIRECT' | 'GROUP' | 'AI';
export type MessageContentType = 'TEXT' | 'IMAGE' | 'FILE' | 'VOICE' | 'SYSTEM';

export interface MessagingUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  content: string | null;
  contentType: MessageContentType;
  isDeleted: boolean;
  isAiGenerated: boolean;
  createdAt: string;
  editedAt: string | null;
  /**
   * Server-filtered metadata envelope (FAZ 2 contract). The backend strips
   * server-protected keys (status/isAi/actionId) before the read path, so the
   * UI only ever sees client-relevant flags here — chiefly `error: true` (+
   * `errorCode`) on AI failure notices. Client code must treat it as advisory
   * only: AI authorship is decided by `senderId`/`isAiGenerated`, NEVER by
   * metadata (a user-sent message cannot forge those server-stamped fields,
   * but its metadata is its own).
   */
  metadata: Record<string, unknown> | null;
  sender: MessagingUser | null;
}

export interface ChannelMember {
  id: string;
  userId: string;
  role: string;
  user: MessagingUser | null;
}

export interface Channel {
  id: string;
  type: ChannelType;
  name: string | null;
  description: string | null;
  avatarUrl: string | null;
  isArchived: boolean;
  aiPersona: string | null;
  unreadCount: number | null;
  memberCount: number | null;
  createdAt: string;
  updatedAt: string;
  lastMessage: Message | null;
  members: ChannelMember[] | null;
}

export interface AiPersona {
  id: string;
  name: string;
  description: string;
}
