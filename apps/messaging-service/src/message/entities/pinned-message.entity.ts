/**
 * @module PinnedMessage
 * @description Entity representing a pinned message in a channel. Tracks who pinned
 * it and when. Unique constraint ensures each message can only be pinned once per channel.
 * @see ADR-012 section 4.5 (Pinned Messages)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Channel } from '../../channel/entities/channel.entity';
import { Message } from './message.entity';

@ObjectType()
@Entity('pinned_messages')
@Unique('uq_pin_channel_message', ['channelId', 'messageId'])
@Index('idx_pins_channel', ['channelId', 'pinnedAt'])
@Index('idx_pins_tenant', ['tenantId'])
export class PinnedMessage {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant identifier — backfilled from parent channel in migration
   * 1782300000000-AddTenantIdToMessageChildren. Required for
   * tenant_isolation_policy RLS predicate (ADR-011).
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid' })
  channelId!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'timestamptz' })
  messageCreatedAt!: Date;

  @Field()
  @Column({ type: 'uuid' })
  pinnedBy!: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  pinnedAt!: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel!: Channel;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'messageId', referencedColumnName: 'id' },
    { name: 'messageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  @Field(() => Message)
  message!: Message;
}
