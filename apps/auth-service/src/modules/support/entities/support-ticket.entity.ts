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
  BeforeInsert,
} from 'typeorm';

import { Tenant } from '../../tenant/entities/tenant.entity';

/**
 * Ticket priority levels
 */
export enum TicketPriority {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

registerEnumType(TicketPriority, {
  name: 'TicketPriority',
  description: 'Support ticket priority level',
});

/**
 * Ticket status workflow
 */
export enum TicketStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  WAITING_CUSTOMER = 'waiting_customer',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

registerEnumType(TicketStatus, {
  name: 'TicketStatus',
  description: 'Support ticket status',
});

/**
 * Ticket category
 */
export enum TicketCategory {
  TECHNICAL = 'technical',
  BILLING = 'billing',
  FEATURE_REQUEST = 'feature_request',
  BUG = 'bug',
  GENERAL = 'general',
}

registerEnumType(TicketCategory, {
  name: 'TicketCategory',
  description: 'Support ticket category',
});

/**
 * SupportTicket Entity
 *
 * Support tickets created by tenant admins.
 * Managed by super admins with SLA tracking.
 */
@Entity('support_tickets')
@ObjectType()
@Index(['tenantId', 'status'])
@Index(['assignedTo', 'status'])
@Index(['priority', 'status'])
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  @Column({ unique: true })
  @Field()
  ticketNumber!: string;

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

  @Column({ type: 'text' })
  @Field()
  description!: string;

  @Column({ type: 'enum', enum: TicketCategory })
  @Field(() => TicketCategory)
  category!: TicketCategory;

  @Column({ type: 'enum', enum: TicketPriority, default: TicketPriority.MEDIUM })
  @Field(() => TicketPriority)
  priority!: TicketPriority;

  @Column({ type: 'enum', enum: TicketStatus, default: TicketStatus.OPEN })
  @Field(() => TicketStatus)
  status!: TicketStatus;

  @Column({ type: 'uuid', nullable: true })
  @Field(() => String, { nullable: true })
  assignedTo?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  @Field(() => String, { nullable: true })
  assignedToName?: string;

  @Column({ type: 'uuid' })
  @Field()
  reportedBy!: string;

  @Column()
  @Field()
  reportedByName!: string;

  @Column({ default: 0 })
  @Field()
  commentCount!: number;

  // SLA tracking
  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  slaResponseDeadline?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  slaResolutionDeadline?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  firstResponseAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  resolvedAt?: Date | null;

  // Satisfaction
  @Column({ type: 'int', nullable: true })
  @Field(() => Number, { nullable: true })
  satisfactionRating?: number | null; // 1-5 stars

  @Column({ type: 'text', nullable: true })
  @Field(() => String, { nullable: true })
  satisfactionComment?: string | null;

  @Column({ type: 'simple-array', nullable: true })
  @Field(() => [String], { nullable: true })
  tags?: string[] | null;

  @CreateDateColumn()
  @Field()
  createdAt!: Date;

  @UpdateDateColumn()
  @Field()
  updatedAt!: Date;

  // Virtual field - tenant name
  @Field(() => String, { nullable: true })
  tenantName?: string;

  /**
   * Generate ticket number before insert
   */
  @BeforeInsert()
  generateTicketNumber() {
    const year = new Date().getFullYear();
    const random = Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, '0');
    this.ticketNumber = `TKT-${year}-${random}`;
  }

  /**
   * Check if SLA response is breached
   */
  isResponseSLABreached(): boolean {
    if (!this.slaResponseDeadline || this.firstResponseAt) return false;
    return new Date() > new Date(this.slaResponseDeadline);
  }

  /**
   * Check if SLA resolution is breached
   */
  isResolutionSLABreached(): boolean {
    if (!this.slaResolutionDeadline || this.resolvedAt) return false;
    if (this.status === TicketStatus.RESOLVED || this.status === TicketStatus.CLOSED) return false;
    return new Date() > new Date(this.slaResolutionDeadline);
  }
}
