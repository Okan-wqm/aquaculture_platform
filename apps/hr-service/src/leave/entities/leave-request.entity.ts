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
import { DecimalTransformer } from '@aquaculture/backend-common';
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
// Unique index
@Index('idx_leave_request_number', ['tenantId', 'requestNumber'], { unique: true })
// Composite indexes for common query patterns
@Index('idx_leave_tenant_employee', ['tenantId', 'employeeId'])
@Index('idx_leave_tenant_status', ['tenantId', 'status'])
@Index('idx_leave_date_range', ['startDate', 'endDate'])
// Extended composite indexes
@Index(['tenantId', 'employeeId', 'status'])
@Index(['tenantId', 'startDate', 'endDate'])
@Index(['tenantId', 'status', 'createdAt'])
@Index(['tenantId', 'approvedBy'])
// HR-MEDIUM-002: DB-level exclusion constraint for overlapping leave detection.
// Application-level overlap checks are insufficient under concurrent requests.
// The EXCLUDE USING gist constraint makes overlapping leaves for the same employee
// STRUCTURALLY IMPOSSIBLE at the database level, regardless of application-layer races.
// NOTE: Requires btree_gist extension. The migration adds:
//   ALTER TABLE leave_requests ADD CONSTRAINT leave_no_overlap
//     EXCLUDE USING gist (
//       tenant_id WITH =,
//       employee_id WITH =,
//       daterange("startDate", "endDate", '[]') WITH &&
//     ) WHERE (status NOT IN ('cancelled', 'rejected', 'withdrawn') AND "isDeleted" = false);
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

  @Field(() => Employee, { nullable: true })
  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field()
  @Column()
  leaveTypeId!: string;

  @Field(() => LeaveType, { nullable: true })
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
  // DecimalTransformer: totalDays is computed from startDate to endDate and used in leave balance deductions.
  // String subtraction of leave days from balance produces NaN.
  @Column({ type: 'decimal', precision: 5, scale: 2, transformer: new DecimalTransformer() })
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

  /**
   * HR-HIGH-011: Preserved original close reason when a cancelled/rejected
   * request is reopened. The current cancellationReason/rejectionReason may
   * be overwritten, but the original is preserved here for audit trail.
   */
  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  originalCloseReason?: string;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  originalClosedAt?: Date;

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
      // SECURITY: Use cryptographically secure random bytes instead of Math.random()
      // to prevent enumeration attacks on leave request IDs (MED-01).
      const randomBytes = require('crypto').randomBytes(3);
      const random = (randomBytes.readUIntBE(0, 3) % 100000).toString().padStart(5, '0');
      this.requestNumber = `LR-${year}-${random}`;
    }
  }
}
