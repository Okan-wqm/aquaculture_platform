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
export class Channel {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => ChannelType)
  @Column({ type: 'varchar', length: 20, default: ChannelType.GROUP })
  type: ChannelType;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
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

  @OneToMany(() => ChannelMember, (member) => member.channel, { cascade: true })
  members: ChannelMember[];
}
