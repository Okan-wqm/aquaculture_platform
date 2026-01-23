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
 * Message sender type
 */
export enum SenderType {
  SUPER_ADMIN = 'super_admin',
  TENANT_ADMIN = 'tenant_admin',
  SYSTEM = 'system',
}

registerEnumType(SenderType, {
  name: 'SenderType',
  description: 'Who sent the message',
});

/**
 * Message status
 */
export enum MessageStatus {
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
}

registerEnumType(MessageStatus, {
  name: 'MessageStatus',
  description: 'Message delivery status',
});

/**
 * Message attachment type
 */
@ObjectType()
export class MessageAttachment {
  @Field()
  id: string;

  @Field()
  filename: string;

  @Field()
  url: string;

  @Field()
  size: number;

  @Field()
  mimeType: string;
}

/**
 * Message Entity
 *
 * Individual message within a thread.
 * Supports internal notes (visible only to admins).
 */
@Entity('messages')
@ObjectType()
@Index(['threadId', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id: string;

  @Column({ type: 'uuid' })
  @Field()
  @Index()
  threadId: string;

  @ManyToOne(() => MessageThread, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'threadId' })
  thread: MessageThread;

  @Column({ type: 'uuid' })
  @Field()
  senderId: string;

  @Column({ type: 'enum', enum: SenderType })
  @Field(() => SenderType)
  senderType: SenderType;

  @Column()
  @Field()
  senderName: string;

  @Column({ type: 'text' })
  @Field()
  content: string;

  @Column({ type: 'enum', enum: MessageStatus, default: MessageStatus.SENT })
  @Field(() => MessageStatus)
  status: MessageStatus;

  @Column({ default: false })
  @Field()
  isInternal: boolean; // Internal note - visible only to admins

  @Column({ type: 'jsonb', nullable: true })
  @Field(() => [MessageAttachment], { nullable: true })
  attachments: MessageAttachment[] | null;

  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  readAt: Date | null;

  @CreateDateColumn()
  @Field()
  createdAt: Date;
}
