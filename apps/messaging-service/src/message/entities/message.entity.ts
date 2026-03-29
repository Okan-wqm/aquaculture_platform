import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  OneToMany,
  Index,
  Check,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { MessageAttachment } from './message-attachment.entity';
import { MessageReceipt } from './message-receipt.entity';
import { MessageReaction } from './message-reaction.entity';

export enum MessageContentType {
  TEXT = 'text',
  IMAGE = 'image',
  FILE = 'file',
  VOICE = 'voice',
  SYSTEM = 'system',
}

registerEnumType(MessageContentType, { name: 'MessageContentType' });

/**
 * Message entity — partitioned by created_at (RANGE monthly).
 * TypeORM synchronize=false for this table; all schema changes via migrations.
 * Composite PK (id, createdAt) required for partition routing.
 */
@ObjectType()
@Entity('messages')
@Check(`"contentType" IN ('text', 'image', 'file', 'voice', 'system')`)
@Index('idx_messages_channel_created', ['channelId', 'createdAt'])
@Index('idx_messages_sender', ['senderId', 'createdAt'])
export class Message {
  @Field(() => ID)
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Field()
  @Column({ type: 'uuid' })
  channelId: string;

  @Field()
  @Column({ type: 'uuid' })
  senderId: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Field(() => MessageContentType)
  @Column({ type: 'varchar', length: 20, default: MessageContentType.TEXT })
  contentType: MessageContentType;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  parentId: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  forwardedFrom: string | null;

  @Column({ type: 'uuid' })
  idempotencyKey: string;

  @Field()
  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @Field()
  @PrimaryColumn({ type: 'timestamptz', default: () => 'NOW()' })
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  editedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @OneToMany(() => MessageAttachment, (att) => att.message)
  attachments: MessageAttachment[];

  @OneToMany(() => MessageReceipt, (receipt) => receipt.message)
  receipts: MessageReceipt[];

  @OneToMany(() => MessageReaction, (reaction) => reaction.message)
  reactions: MessageReaction[];
}
