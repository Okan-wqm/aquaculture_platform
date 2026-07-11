/**
 * @module ChannelMember
 * @description Channel membership entity with role hierarchy (OWNER > ADMIN > MEMBER),
 * notification preferences, and soft-leave via leftAt timestamp.
 * @see ADR-012 section 3.2 (Channel Membership)
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
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Channel } from './channel.entity';

export enum ChannelMemberRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
}

export enum NotificationPreference {
  ALL = 'all',
  MENTIONS = 'mentions',
  NONE = 'none',
}

// INFRA-CRITICAL-013: explicit valuesMap for both registerEnumType calls.
//
// Both TypeScript enums are value-mapped string enums (key !== value):
//   ChannelMemberRole.MEMBER === 'member'    (key 'MEMBER', value 'member')
//   NotificationPreference.ALL === 'all'     (key 'ALL', value 'all')
//
// Without an explicit valuesMap, NestJS GraphQL exposes the enum NAMES as
// GraphQL values but on input deserialization the raw NAME (e.g. 'MEMBER')
// can leak through to the resolver param → command handler → SQL parameter,
// where the CHECK constraint chk_member_role rejects it ('owner','admin',
// 'member' are the only legal values). Per CI run 24637240275:
//
//   new row for relation "channel_members" violates check constraint
//   "chk_member_role" — failing row contains MEMBER, all, ...
//
// Architectural fix (T1, canonical input boundary normalization): the
// valuesMap pins each GraphQL enum NAME to the TypeScript enum VALUE so
// every coercion path lands on the lowercase form before the value reaches
// any DB write. This is the single point of truth — handlers, resolvers,
// and direct DB writes all see the canonical lowercase value.
// INFRA-CRITICAL-014: NestJS `EnumMetadataValuesMapOptions` only accepts
// `description?` and `deprecationReason?` — `value` is NOT in the type
// signature (verified at node_modules/@nestjs/graphql/dist/schema-builder
// /metadata/enum.metadata.d.ts). Attempting to override the value mapping
// here was wrong API; NestJS coerces enum values automatically via the
// TypeScript enum's own key→value map (Object.entries(enum)).
//
// The actual GraphQL-name → TS-value boundary normalization for
// ChannelMemberRole lives in channel.resolver.ts:227 — that's the
// architectural T1 fix. The valuesMap here is metadata-only (schema
// docs) and must conform to the strict shape.
registerEnumType(ChannelMemberRole, {
  name: 'ChannelMemberRole',
  description: 'Channel membership role hierarchy: OWNER > ADMIN > MEMBER',
  valuesMap: {
    OWNER: { description: 'Channel owner — full administrative + delete' },
    ADMIN: { description: 'Channel admin — manage members + content' },
    MEMBER: { description: 'Regular channel member' },
  },
});

registerEnumType(NotificationPreference, {
  name: 'NotificationPreference',
  description: 'Channel notification preference: ALL > MENTIONS > NONE',
  valuesMap: {
    ALL: { description: 'Notify on every message' },
    MENTIONS: { description: 'Notify only on @mentions' },
    NONE: { description: 'No notifications' },
  },
});

@ObjectType()
@Entity('channel_members')
@Unique('uq_channel_member', ['channelId', 'userId'])
@Index('idx_channel_members_user_id', ['userId'])
@Index('idx_channel_members_channel_id', ['channelId'])
@Index('idx_channel_members_tenant', ['tenantId'])
export class ChannelMember {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant identifier for multi-tenant isolation.
   * @see DB-HIGH-001 (messaging tables missing tenant_id)
   */
  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid' })
  channelId!: string;

  @Field()
  @Column({ type: 'uuid' })
  userId!: string;

  @Field(() => ChannelMemberRole)
  @Column({ type: 'varchar', length: 20, default: ChannelMemberRole.MEMBER })
  role!: ChannelMemberRole;

  @Field(() => NotificationPreference)
  @Column({
    type: 'varchar',
    length: 20,
    default: NotificationPreference.ALL,
  })
  notificationPreference!: NotificationPreference;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastReadAt!: Date | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  joinedAt!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  leftAt!: Date | null;

  @ManyToOne(() => Channel, (channel) => channel.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel!: Channel;
}
