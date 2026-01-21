import { InputType, Field, ObjectType, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsUUID, IsOptional, IsBoolean } from 'class-validator';

import { ThreadStatus } from '../entities/message-thread.entity';
import { SenderType, MessageStatus, MessageAttachment } from '../entities/message.entity';

/**
 * Input for creating a new thread
 */
@InputType()
export class CreateThreadInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  subject: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  initialMessage: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  tenantId?: string; // Required for SuperAdmin, auto-filled for TenantAdmin
}

/**
 * Input for sending a message
 */
@InputType()
export class SendMessageInput {
  @Field()
  @IsUUID()
  threadId: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  content: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  isInternal: boolean; // Internal note (only for admins)
}

/**
 * Input for bulk message (SuperAdmin only)
 */
@InputType()
export class BulkMessageInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  subject: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  content: string;

  @Field(() => String)
  targetType: 'all' | 'plan' | 'module' | 'region' | 'custom';

  @Field(() => [String], { nullable: true })
  targetValues?: string[]; // Plan names, module IDs, etc.

  @Field({ defaultValue: true })
  sendEmailNotification: boolean;
}

/**
 * Thread list item for display
 */
@ObjectType()
export class ThreadListItem {
  @Field(() => ID)
  id: string;

  @Field()
  tenantId: string;

  @Field()
  tenantName: string;

  @Field()
  subject: string;

  @Field(() => String, { nullable: true })
  lastMessage: string | null;

  @Field(() => Date, { nullable: true })
  lastMessageAt: Date | null;

  @Field()
  unreadCount: number;

  @Field()
  messageCount: number;

  @Field(() => ThreadStatus)
  status: ThreadStatus;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

/**
 * Message for display
 */
@ObjectType()
export class MessageItem {
  @Field(() => ID)
  id: string;

  @Field()
  threadId: string;

  @Field()
  senderId: string;

  @Field(() => SenderType)
  senderType: SenderType;

  @Field()
  senderName: string;

  @Field()
  content: string;

  @Field(() => MessageStatus)
  status: MessageStatus;

  @Field()
  isInternal: boolean;

  @Field(() => [MessageAttachment], { nullable: true })
  attachments: MessageAttachment[] | null;

  @Field(() => Date, { nullable: true })
  readAt: Date | null;

  @Field()
  createdAt: Date;
}

/**
 * Messaging statistics
 */
@ObjectType()
export class MessagingStats {
  @Field()
  totalThreads: number;

  @Field()
  activeThreads: number;

  @Field()
  closedThreads: number;

  @Field()
  totalMessages: number;

  @Field()
  unreadMessages: number;

  @Field()
  avgResponseTimeMinutes: number;
}
