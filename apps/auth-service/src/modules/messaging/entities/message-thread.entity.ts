import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Tenant } from '../../tenant/entities/tenant.entity';

/**
 * Thread status enum
 */
export enum ThreadStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  ARCHIVED = 'archived',
}

registerEnumType(ThreadStatus, {
  name: 'ThreadStatus',
  description: 'Message thread status',
});

/**
 * MessageThread Entity
 *
 * Represents a conversation thread between SuperAdmin and TenantAdmin.
 * Each thread belongs to a tenant and can have multiple messages.
 */
@Entity('message_threads')
@ObjectType()
@Index(['tenantId', 'status'])
@Index(['tenantId', 'updatedAt'])
export class MessageThread {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id: string;

  @Column({ type: 'uuid' })
  @Field()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  @Field()
  subject: string;

  @Column({ type: 'text', nullable: true })
  @Field(() => String, { nullable: true })
  lastMessage: string | null;

  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  lastMessageAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  @Field(() => String, { nullable: true })
  lastMessageBy: string | null;

  @Column({ type: 'enum', enum: ThreadStatus, default: ThreadStatus.OPEN })
  @Field(() => ThreadStatus)
  status: ThreadStatus;

  @Column({ default: 0 })
  @Field()
  messageCount: number;

  @Column({ default: 0 })
  @Field()
  unreadCountAdmin: number; // Unread by SuperAdmin

  @Column({ default: 0 })
  @Field()
  unreadCountTenant: number; // Unread by TenantAdmin

  @Column({ type: 'uuid' })
  @Field()
  createdBy: string; // User ID who started the thread

  @Column({ default: false })
  @Field()
  createdByAdmin: boolean; // true if SuperAdmin started

  @CreateDateColumn()
  @Field()
  createdAt: Date;

  @UpdateDateColumn()
  @Field()
  updatedAt: Date;

  // Virtual field - tenant name (populated via relation)
  @Field(() => String, { nullable: true })
  tenantName?: string;
}
