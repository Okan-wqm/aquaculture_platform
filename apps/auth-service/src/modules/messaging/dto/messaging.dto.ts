import { InputType, Field, ObjectType, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsUUID, IsOptional, IsBoolean, MaxLength, IsArray, ArrayMaxSize, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';

import { escapeHtml } from '../../../utils/sanitize';

import { ThreadStatus } from '../entities/message-thread.entity';
import { SenderType, MessageStatus, MessageAttachment } from '../entities/message.entity';

/**
 * Input for creating a new support thread (admin-to-tenant).
 * Renamed to SupportCreateThreadInput to avoid potential Federation conflicts.
 */
@InputType('SupportCreateThreadInput')
export class CreateThreadInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255, { message: 'Subject must be at most 255 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
  subject!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(10000, { message: 'Message must be at most 10000 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
  initialMessage!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'Invalid tenant ID format' })
  tenantId?: string; // Required for SuperAdmin, auto-filled for TenantAdmin
}

/**
 * Input for sending a support message (admin-to-tenant).
 * Renamed to SupportSendMessageInput to avoid Apollo Federation conflict
 * with messaging-service's SendMessageInput.
 */
@InputType('SupportSendMessageInput')
export class SendMessageInput {
  @Field()
  @IsUUID('4', { message: 'Invalid thread ID format' })
  threadId!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(10000, { message: 'Message must be at most 10000 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
  content!: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  isInternal!: boolean; // Internal note (only for admins)
}

/**
 * Input for bulk support message (SuperAdmin only).
 * Renamed to SupportBulkMessageInput to avoid potential Federation conflicts.
 */
@InputType('SupportBulkMessageInput')
export class BulkMessageInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255, { message: 'Subject must be at most 255 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
  subject!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(10000, { message: 'Message must be at most 10000 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
  content!: string;

  @Field(() => String)
  @IsIn(['all', 'plan', 'module', 'region', 'custom'], { message: 'Invalid target type' })
  targetType!: 'all' | 'plan' | 'module' | 'region' | 'custom';

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: 'Maximum 100 target values allowed' })
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  targetValues?: string[]; // Plan names, module IDs, etc.

  @Field({ defaultValue: true })
  @IsBoolean()
  sendEmailNotification!: boolean;
}

/**
 * Thread list item for display (admin-to-tenant support).
 * Renamed to SupportThreadListItem to avoid potential Federation conflicts.
 */
@ObjectType('SupportThreadListItem')
export class ThreadListItem {
  @Field(() => ID)
  id!: string;

  @Field()
  tenantId!: string;

  @Field()
  tenantName!: string;

  @Field()
  subject!: string;

  @Field(() => String, { nullable: true })
  lastMessage!: string | null;

  @Field(() => Date, { nullable: true })
  lastMessageAt!: Date | null;

  @Field()
  unreadCount!: number;

  @Field()
  messageCount!: number;

  @Field(() => ThreadStatus)
  status!: ThreadStatus;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

/**
 * Support message for display (admin-to-tenant).
 * Renamed to SupportMessageItem to avoid Federation conflicts.
 */
@ObjectType('SupportMessageItem')
export class MessageItem {
  @Field(() => ID)
  id!: string;

  @Field()
  threadId!: string;

  @Field()
  senderId!: string;

  @Field(() => SenderType, { description: 'Support message sender type' })
  senderType!: SenderType;

  @Field()
  senderName!: string;

  @Field()
  content!: string;

  @Field(() => MessageStatus, { description: 'Support message delivery status' })
  status!: MessageStatus;

  @Field()
  isInternal!: boolean;

  @Field(() => [MessageAttachment], { nullable: true })
  attachments!: MessageAttachment[] | null;

  @Field(() => Date, { nullable: true })
  readAt!: Date | null;

  @Field()
  createdAt!: Date;
}

/**
 * Support messaging statistics (admin-to-tenant).
 * Renamed to SupportMessagingStats to avoid potential Federation conflicts.
 */
@ObjectType('SupportMessagingStats')
export class MessagingStats {
  @Field()
  totalThreads!: number;

  @Field()
  activeThreads!: number;

  @Field()
  closedThreads!: number;

  @Field()
  totalMessages!: number;

  @Field()
  unreadMessages!: number;

  @Field()
  avgResponseTimeMinutes!: number;
}
