import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';
import { LeaveType } from './leave-type.entity';

export enum LeaveRequestStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  WITHDRAWN = 'withdrawn',
}

export enum HalfDayPeriod {
  AM = 'am',
  PM = 'pm',
}

registerEnumType(LeaveRequestStatus, { name: 'LeaveRequestStatus' });
registerEnumType(HalfDayPeriod, { name: 'HalfDayPeriod' });

@ObjectType()
export class ApprovalHistoryEntry {
  @Field()
  action!: string;

  @Field()
  actorId!: string;

  @Field()
  timestamp!: Date;

  @Field({ nullable: true })
  notes?: string;
}

@ObjectType()
export class LeaveAttachment {
  @Field()
  documentId!: string;

  @Field()
  fileName!: string;

  @Field()
  uploadedAt!: Date;
}

@ObjectType()
@Entity('leave_requests', { schema: 'hr' })
@Index(['tenantId', 'requestNumber'], { unique: true })
@Index(['tenantId', 'employeeId', 'status'])
@Index(['tenantId', 'startDate', 'endDate'])
@Index(['tenantId', 'status', 'createdAt'])
@Index(['tenantId', 'approvedBy'])
export class LeaveRequest {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 30 })
  requestNumber!: string;

  @Field()
  @Column()
  @Index()
  employeeId!: string;

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field()
  @Column()
  leaveTypeId!: string;

  @ManyToOne(() => LeaveType, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'leaveTypeId' })
  leaveType?: LeaveType;

  @Field()
  @Column({ type: 'date' })
  startDate!: Date;

  @Field()
  @Column({ type: 'date' })
  endDate!: Date;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 2 })
  totalDays!: number;

  @Field()
  @Column({ default: false })
  isHalfDayStart!: boolean;

  @Field()
  @Column({ default: false })
  isHalfDayEnd!: boolean;

  @Field(() => HalfDayPeriod, { nullable: true })
  @Column({ type: 'enum', enum: HalfDayPeriod, nullable: true })
  halfDayPeriod?: HalfDayPeriod;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  reason?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  contactDuringLeave?: string;

  @Field(() => LeaveRequestStatus)
  @Column({ type: 'enum', enum: LeaveRequestStatus, default: LeaveRequestStatus.DRAFT })
  status!: LeaveRequestStatus;

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  currentApprovalLevel!: number;

  @Field(() => [ApprovalHistoryEntry], { nullable: true })
  @Column('jsonb', { nullable: true })
  approvalHistory?: ApprovalHistoryEntry[];

  @Field({ nullable: true })
  @Column({ nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  rejectedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  rejectedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  rejectionReason?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  cancelledBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  cancellationReason?: string;

  @Field(() => [LeaveAttachment], { nullable: true })
  @Column('jsonb', { nullable: true })
  attachments?: LeaveAttachment[];

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

  @Field()
  @Column({ default: false })
  isDeleted!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedBy?: string;

  @BeforeInsert()
  generateRequestNumber(): void {
    if (!this.requestNumber) {
      const year = new Date().getFullYear();
      const random = Math.floor(Math.random() * 100000)
        .toString()
        .padStart(5, '0');
      this.requestNumber = `LR-${year}-${random}`;
    }
  }
}
