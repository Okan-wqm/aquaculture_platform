/**
 * @module Channel
 * @description Channel entity representing a messaging channel (DIRECT, GROUP, or AI).
 * Uses PostgreSQL check constraints to enforce type invariants and DM pair uniqueness.
 * @see ADR-012 section 3 (Channel domain)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  Check,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { ChannelMember } from './channel-member.entity';

export enum ChannelType {
  DIRECT = 'direct',
  GROUP = 'group',
  AI = 'ai',
}

registerEnumType(ChannelType, { name: 'ChannelType' });

@ObjectType()
@Entity('channels')
@Check(`"type" IN ('direct', 'group', 'ai')`)
@Check(
  `("type" = 'direct' AND "dmPairKey" IS NOT NULL) OR ("type" != 'direct' AND "dmPairKey" IS NULL)`,
)
@Index('idx_channels_type', ['type'])
@Index('idx_channels_created_by', ['createdBy'])
@Index('idx_channels_tenant', ['tenantId'])
@Index('idx_channels_tenant_id', ['tenantId', 'id'], { unique: true })
@Index('idx_channels_tenant_dm_pair', ['tenantId', 'dmPairKey'], {
  unique: true,
  where: '"dmPairKey" IS NOT NULL',
})
export class Channel {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Tenant identifier for multi-tenant isolation.
   * SECURITY: Required for RLS policies and direct tenant-scoped queries
   * without joining to parent entities.
   * @see DB-HIGH-001 (messaging tables missing tenant_id)
   */
  @Field()
  @Column({ type: 'uuid' })
  tenantId: string;

  @Field(() => ChannelType)
  @Column({ type: 'varchar', length: 20, default: ChannelType.GROUP })
  type: ChannelType;

  /**
   * Channel display name. Limited to 100 characters to reduce index storage
   * overhead. varchar(255) was wasteful since channel names are typically short.
   * @see DB-MEDIUM-006
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  name: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 1024, nullable: true })
  avatarUrl: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @Field()
  @Column({ type: 'boolean', default: false })
  isArchived: boolean;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'varchar', length: 73, nullable: true })
  dmPairKey: string | null;

  /** AI persona ID for AI channels (e.g., 'expert-v1', 'operator-v1'). Null = general AI chat. */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  aiPersona: string | null;

  /** Custom MCP server URL override. Null = use default ai-service via NATS. */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 512, nullable: true })
  aiServiceUrl: string | null;

  /**
   * Active members of this channel.
   * GraphQL field declared via @ResolveField on ChannelResolver — not via @Field here
   * to avoid duplicate schema declarations.
   */
  @OneToMany(() => ChannelMember, (member) => member.channel, { cascade: true })
  members: ChannelMember[];

  /**
   * Number of active members in this channel.
   * Computed via SQL subquery in GetChannelsHandler and exposed via @ResolveField.
   * Not persisted — virtual property attached at runtime.
   */
  memberCount?: number;

  /**
   * Number of unread messages for the requesting user.
   * Computed via SQL subquery in GetChannelsHandler and exposed via @ResolveField.
   * Not persisted — virtual property attached at runtime.
   */
  unreadCount?: number;
}
