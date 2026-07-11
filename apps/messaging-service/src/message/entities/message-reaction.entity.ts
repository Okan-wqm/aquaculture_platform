/**
 * @module MessageReaction
 * @description Emoji reaction entity for messages. Enforces unique constraint
 * per (message, user, emoji) combination. Partitioned via message's createdAt.
 * @see ADR-012 section 4.4 (Reactions)
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
import { Message } from './message.entity';

@ObjectType()
@Entity('message_reactions')
@Unique('uq_reaction_message_user_emoji', ['messageId', 'userId', 'emoji'])
@Index('idx_reactions_message', ['messageId'])
@Index('idx_reactions_tenant', ['tenantId'])
export class MessageReaction {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant identifier — backfilled from parent message in migration
   * 1782300000000-AddTenantIdToMessageChildren. Required for
   * tenant_isolation_policy RLS predicate (ADR-011).
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'timestamptz' })
  messageCreatedAt!: Date;

  @Field()
  @Column({ type: 'uuid' })
  userId!: string;

  @Field()
  @Column({ type: 'varchar', length: 32 })
  emoji!: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => Message, (msg) => msg.reactions, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'messageId', referencedColumnName: 'id' },
    { name: 'messageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  message!: Message;
}
