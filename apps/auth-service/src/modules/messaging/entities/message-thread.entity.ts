import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../../tenant/entities/tenant.entity';

/**
 * Support thread status enum.
 * Prefixed with 'Support' to avoid Apollo Federation conflicts
 * with messaging-service types.
 */
export enum ThreadStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  ARCHIVED = 'archived',
}

registerEnumType(ThreadStatus, {
  name: 'SupportThreadStatus',
  description: 'Support message thread status',
});

/**
 * MessageThread Entity
 *
 * Represents a conversation thread between SuperAdmin and TenantAdmin
 * (admin-to-tenant support messaging).
 * Each thread belongs to a tenant and can have multiple messages.
 *
 * GraphQL type renamed to 'SupportMessageThread' to avoid Apollo Federation
 * conflict with messaging-service types.
 * DB table name remains 'message_threads' (auth schema).
 */
@Entity('message_threads')
@ObjectType('SupportMessageThread')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'updatedAt'])
export class MessageThread {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  @Column({ type: 'uuid' })
  @Field()
  @Index()
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @Column()
  @Field()
  subject!: string;

  @Column({ type: 'text', nullable: true })
  @Field(() => String, { nullable: true })
  lastMessage?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  @Field(() => Date, { nullable: true })
  lastMessageAt?: Date | null;

  @Column({ type: 'uuid', nullable: true })
  @Field(() => String, { nullable: true })
  lastMessageBy?: string | null;

  @Column({ type: 'enum', enum: ThreadStatus, default: ThreadStatus.OPEN })
  @Field(() => ThreadStatus)
  status!: ThreadStatus;

  @Column({ default: 0 })
  @Field()
  messageCount!: number;

  @Column({ default: 0 })
  @Field()
  unreadCountAdmin!: number; // Unread by SuperAdmin

  @Column({ default: 0 })
  @Field()
  unreadCountTenant!: number; // Unread by TenantAdmin

  @Column({ type: 'uuid' })
  @Field()
  createdBy!: string; // User ID who started the thread

  @Column({ default: false })
  @Field()
  createdByAdmin!: boolean; // true if SuperAdmin started

  @CreateDateColumn()
  @Field()
  createdAt!: Date;

  @UpdateDateColumn()
  @Field()
  updatedAt!: Date;

  // Virtual field - tenant name (populated via relation)
  @Field(() => String, { nullable: true })
  tenantName?: string;
}
