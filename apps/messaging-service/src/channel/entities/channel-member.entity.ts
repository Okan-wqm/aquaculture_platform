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

registerEnumType(ChannelMemberRole, { name: 'ChannelMemberRole' });
registerEnumType(NotificationPreference, { name: 'NotificationPreference' });

@ObjectType()
@Entity('channel_members')
@Unique('uq_channel_member', ['channelId', 'userId'])
@Index('idx_channel_members_user_id', ['userId'])
@Index('idx_channel_members_channel_id', ['channelId'])
export class ChannelMember {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ type: 'uuid' })
  channelId: string;

  @Field()
  @Column({ type: 'uuid' })
  userId: string;

  @Field(() => ChannelMemberRole)
  @Column({ type: 'varchar', length: 20, default: ChannelMemberRole.MEMBER })
  role: ChannelMemberRole;

  @Field(() => NotificationPreference)
  @Column({
    type: 'varchar',
    length: 20,
    default: NotificationPreference.ALL,
  })
  notificationPreference: NotificationPreference;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastReadAt: Date | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  joinedAt: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  leftAt: Date | null;

  @ManyToOne(() => Channel, (channel) => channel.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel: Channel;
}
