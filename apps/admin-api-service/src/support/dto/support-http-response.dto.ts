import {
  Announcement,
  AnnouncementAcknowledgment,
  type AnnouncementStatus,
  type AnnouncementTarget,
  type AnnouncementType,
  Message,
  type MessageAttachment,
  type MessageStatus,
  MessageThread,
  TicketComment,
  type TicketAttachment,
} from '../entities/support.entity';

/** Scalar HTTP projection; TypeORM relations are deliberately absent. */
export interface AnnouncementDto {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  status: AnnouncementStatus;
  isGlobal: boolean;
  targetCriteria?: AnnouncementTarget;
  createdBy?: string;
  createdByName?: string;
  publishAt?: Date;
  expiresAt?: Date;
  requiresAcknowledgment: boolean;
  viewCount: number;
  acknowledgmentCount: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnnouncementAcknowledgmentDto {
  id: string;
  announcementId: string;
  tenantId: string;
  userId: string;
  userName?: string;
  viewedAt?: Date;
  acknowledgedAt?: Date;
  createdAt: Date;
}

export interface AnnouncementAcknowledgmentStatusDto {
  totalViews: number;
  totalAcknowledgments: number;
  acknowledgments: AnnouncementAcknowledgmentDto[];
}

/** Scalar HTTP projection; the messages relation has its own route. */
export interface MessageThreadDto {
  id: string;
  tenantId: string;
  subject: string;
  lastMessageId?: string;
  messageCount: number;
  unreadAdminCount: number;
  unreadTenantCount: number;
  isArchived: boolean;
  isClosed: boolean;
  lastMessageAt?: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Scalar HTTP projection; the owning thread relation is deliberately absent. */
export interface SupportMessageDto {
  id: string;
  threadId: string;
  senderId: string;
  senderType: 'admin' | 'tenant_admin' | 'system';
  senderName?: string;
  content: string;
  status: MessageStatus;
  isInternal: boolean;
  attachments?: MessageAttachment[];
  readAt?: Date;
  emailSent: boolean;
  createdAt: Date;
}

/** Scalar HTTP projection; the owning ticket relation is deliberately absent. */
export interface TicketCommentDto {
  id: string;
  ticketId: string;
  authorId: string;
  authorType: 'admin' | 'tenant_user' | 'system';
  authorName?: string;
  content: string;
  isInternal: boolean;
  attachments?: TicketAttachment[];
  emailSent: boolean;
  createdAt: Date;
}

export function toAnnouncementDto(source: Announcement): AnnouncementDto {
  return {
    id: source.id,
    title: source.title,
    content: source.content,
    type: source.type,
    status: source.status,
    isGlobal: source.isGlobal,
    targetCriteria: source.targetCriteria,
    createdBy: source.createdBy,
    createdByName: source.createdByName,
    publishAt: source.publishAt,
    expiresAt: source.expiresAt,
    requiresAcknowledgment: source.requiresAcknowledgment,
    viewCount: source.viewCount,
    acknowledgmentCount: source.acknowledgmentCount,
    metadata: source.metadata,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export function toAnnouncementAcknowledgmentDto(
  source: AnnouncementAcknowledgment,
): AnnouncementAcknowledgmentDto {
  return {
    id: source.id,
    announcementId: source.announcementId,
    tenantId: source.tenantId,
    userId: source.userId,
    userName: source.userName,
    viewedAt: source.viewedAt,
    acknowledgedAt: source.acknowledgedAt,
    createdAt: source.createdAt,
  };
}

export function toMessageThreadDto(source: MessageThread): MessageThreadDto {
  return {
    id: source.id,
    tenantId: source.tenantId,
    subject: source.subject,
    lastMessageId: source.lastMessageId,
    messageCount: source.messageCount,
    unreadAdminCount: source.unreadAdminCount,
    unreadTenantCount: source.unreadTenantCount,
    isArchived: source.isArchived,
    isClosed: source.isClosed,
    lastMessageAt: source.lastMessageAt,
    metadata: source.metadata,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export function toSupportMessageDto(source: Message): SupportMessageDto {
  return {
    id: source.id,
    threadId: source.threadId,
    senderId: source.senderId,
    senderType: source.senderType,
    senderName: source.senderName,
    content: source.content,
    status: source.status,
    isInternal: source.isInternal,
    attachments: source.attachments,
    readAt: source.readAt,
    emailSent: source.emailSent,
    createdAt: source.createdAt,
  };
}

export function toTicketCommentDto(source: TicketComment): TicketCommentDto {
  return {
    id: source.id,
    ticketId: source.ticketId,
    authorId: source.authorId,
    authorType: source.authorType,
    authorName: source.authorName,
    content: source.content,
    isInternal: source.isInternal,
    attachments: source.attachments,
    emailSent: source.emailSent,
    createdAt: source.createdAt,
  };
}
