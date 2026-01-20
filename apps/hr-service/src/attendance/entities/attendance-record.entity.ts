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
import { Shift } from './shift.entity';

export enum AttendanceStatus {
  PRESENT = 'present',
  ABSENT = 'absent',
  LATE = 'late',
  EARLY_LEAVE = 'early_leave',
  HALF_DAY = 'half_day',
  ON_LEAVE = 'on_leave',
  HOLIDAY = 'holiday',
  OFFSHORE = 'offshore',
  REST_DAY = 'rest_day',
  WORK_FROM_HOME = 'work_from_home',
}

export enum ClockMethod {
  BIOMETRIC = 'biometric',
  CARD = 'card',
  MOBILE = 'mobile',
  WEB = 'web',
  MANUAL = 'manual',
  GPS = 'gps',
}

export enum ApprovalStatus {
  AUTO_APPROVED = 'auto_approved',
  PENDING_REVIEW = 'pending_review',
  MANAGER_APPROVED = 'manager_approved',
  HR_APPROVED = 'hr_approved',
  REJECTED = 'rejected',
}

registerEnumType(AttendanceStatus, { name: 'AttendanceStatus' });
registerEnumType(ClockMethod, { name: 'ClockMethod' });
registerEnumType(ApprovalStatus, { name: 'ApprovalStatus' });

@ObjectType()
export class GeoLocation {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;

  @Field({ nullable: true })
  address?: string;

  @Field({ nullable: true })
  accuracy?: number;
}

@ObjectType()
@Entity('attendance_records', { schema: 'hr' })
@Index(['tenantId', 'recordNumber'], { unique: true })
@Index(['tenantId', 'employeeId', 'date'])
@Index(['tenantId', 'date', 'status'])
@Index(['tenantId', 'approvalStatus'])
@Index(['tenantId', 'departmentId', 'date'])
export class AttendanceRecord {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 30 })
  recordNumber!: string;

  @Field()
  @Column()
  @Index()
  employeeId!: string;

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field({ nullable: true })
  @Column({ nullable: true })
  departmentId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  shiftId?: string;

  @ManyToOne(() => Shift, { nullable: true })
  @JoinColumn({ name: 'shiftId' })
  shift?: Shift;

  @Field()
  @Column({ type: 'date' })
  date!: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  clockIn?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  clockOut?: Date;

  @Field(() => ClockMethod, { nullable: true })
  @Column({ type: 'enum', enum: ClockMethod, nullable: true })
  clockInMethod?: ClockMethod;

  @Field(() => ClockMethod, { nullable: true })
  @Column({ type: 'enum', enum: ClockMethod, nullable: true })
  clockOutMethod?: ClockMethod;

  @Field(() => GeoLocation, { nullable: true })
  @Column('jsonb', { nullable: true })
  clockInLocation?: GeoLocation;

  @Field(() => GeoLocation, { nullable: true })
  @Column('jsonb', { nullable: true })
  clockOutLocation?: GeoLocation;

  @Field(() => AttendanceStatus)
  @Column({ type: 'enum', enum: AttendanceStatus, default: AttendanceStatus.PRESENT })
  status!: AttendanceStatus;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  workedMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  overtimeMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  lateMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  earlyLeaveMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  breakMinutes!: number;

  @Field(() => ApprovalStatus)
  @Column({ type: 'enum', enum: ApprovalStatus, default: ApprovalStatus.AUTO_APPROVED })
  approvalStatus!: ApprovalStatus;

  @Field({ nullable: true })
  @Column({ nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  remarks?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  reason?: string; // For absences or late arrivals

  @Field()
  @Column({ default: false })
  isManualEntry!: boolean;

  @Field()
  @Column({ default: false })
  isAdjusted!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  adjustedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  adjustmentReason?: string;

  // For offshore work tracking
  @Field({ nullable: true })
  @Column({ nullable: true })
  workAreaId?: string;

  @Field()
  @Column({ default: false })
  isOffshore!: boolean;

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
  generateRecordNumber(): void {
    if (!this.recordNumber) {
      const date = new Date();
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const random = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
      this.recordNumber = `ATT-${year}${month}-${random}`;
    }
  }
}
