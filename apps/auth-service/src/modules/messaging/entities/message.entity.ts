import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

import { MessageThread } from './message-thread.entity';

/**
 * Message sender type (admin-to-tenant support messaging).
 * Prefixed with 'Support' to avoid Apollo Federation conflicts
 * with the tenant-internal messaging-service types.
 */
export enum SenderType {
  SUPER_ADMIN = 'super_admin',
  TENANT_ADMIN = 'tenant_admin',
  SYSTEM = 'system',
}

registerEnumType(SenderType, {
  name: 'SupportSenderType',
  description: 'Who sent the support message (admin-to-tenant)',
});

/**
 * Message status (admin-to-tenant support messaging).
 * Prefixed with 'Support' to avoid Apollo Federation conflicts.
 */
export enum MessageStatus {
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
}

registerEnumType(MessageStatus, {
  name: 'SupportMessageStatus',
  description: 'Support message delivery status',
});

/**
 * Support message attachment type.
 * Renamed to SupportMessageAttachment to avoid Federation conflict
 * with messaging-service's MessageAttachment entity.
 */
@ObjectType('SupportMessageAttachment')
export class MessageAttachment {
  @Field()
  id!: string;

  @Field()
  filename!: string;

  @Field()
  url!: string;

  @Field()
  size!: number;

  @Field()
  mimeType!: string;
}

/**
 * SupportMessage Entity
 *
 * Individual message within an admin-to-tenant support thread.
 * Supports internal notes (visible only to admins).
 *
 * GraphQL type renamed to 'SupportMessage' to avoid Apollo Federation
 * conflict with messaging-service's Message type.
 * DB table name remains 'messages' (auth schema).
 */
@Entity('messages')
@ObjectType('SupportMessage')
@Index(['threadId', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  @Column({ type: 'uuid' })
  @Field()
  @Index()
  threadId!: string;

  @ManyToOne(() => MessageThread, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'threadId' })
  thread!: MessageThread;

  @Column({ type: 'uuid' })
  @Field()
  senderId!: string;

  @Column({ type: 'enum', enum: SenderType })
  @Field(() => SenderType)
  senderType!: SenderType;

  @Column()
  @Field()
  senderName!: string;

  @Column({ type: 'text' })
  @Field()
  content!: string;

  @Column({ type: 'enum', enum: MessageStatus, default: MessageStatus.SENT })
  @Field(() => MessageStatus)
  status!: MessageStatus;

  @Column({ default: false })
  @Field()
  isInternal!: boolean; // Internal note - visible only to admins

  @Column({ type: 'jsonb', nullable: true })
  @Field(() => [MessageAttachment], { nullable: true })
  attachments?: MessageAttachment[] | null;

  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  readAt?: Date | null;

  @CreateDateColumn()
  @Field()
  createdAt!: Date;
}
