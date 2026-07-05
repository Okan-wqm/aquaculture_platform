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

  @Column({ type: 'varchar', length: 73, nullable: true, unique: true })
  dmPairKey: string | null;

  /** AI persona ID for AI channels (e.g., 'expert-v1', 'operator-v1'). Null = general AI chat. */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  aiPersona: string | null;

  // MSG-HIGH-060: the per-channel `aiServiceUrl` override was removed. It let any
  // channel member point the AI at an arbitrary public HTTPS endpoint they
  // controlled; the bridge then POSTed tenantId + the last 50 messages there.
  // SSRF validation only blocked private/internal targets — it did nothing
  // against exfiltration to an attacker's public server. With BYOK (Faz 1) the
  // tenant's AI always runs through ai-service over NATS with the tenant's own
  // key, so a member-specified endpoint is both obsolete and a data-exfil vector.
  //
  // Expand-contract removal: the @Column (and its DB column, dropped in
  // migration 1802000000000) and every write path are gone, but the GraphQL
  // field is retained as a DEPRECATED, always-null field so existing clients
  // (the mobile app still selects it until its codegen is regenerated) keep
  // working — they now receive null instead of a stored endpoint. The field
  // carries no data and no write path, so there is nothing to exfiltrate. The
  // GraphQL field is dropped in a later change once no client selects it.
  @Field(() => String, {
    nullable: true,
    deprecationReason:
      'Removed for security (MSG-HIGH-060). Always null — AI routes through ai-service via the tenant BYOK key.',
  })
  readonly aiServiceUrl: string | null = null;

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
