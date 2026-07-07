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
