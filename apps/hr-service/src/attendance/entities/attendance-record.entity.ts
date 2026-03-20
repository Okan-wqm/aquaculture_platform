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
  AfterLoad,
} from 'typeorm';
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';
import { Shift } from './shift.entity';

/**
 * Helper function to convert a local time to UTC
 * @param localTime - The local Date object
 * @param timezone - IANA timezone string (e.g., 'Asia/Manila', 'America/New_York')
 * @returns Date object in UTC
 */
export function convertLocalToUtc(localTime: Date, timezone: string): Date {
  try {
    const tzOffset = getTimezoneOffset(timezone, localTime);
    return new Date(localTime.getTime() + tzOffset * 60000);
  } catch {
    return localTime;
  }
}

/**
 * Helper function to convert UTC time to local time
 * @param utcTime - The UTC Date object
 * @param timezone - IANA timezone string
 * @returns Date object in local time
 */
export function convertUtcToLocal(utcTime: Date, timezone: string): Date {
  try {
    const tzOffset = getTimezoneOffset(timezone, utcTime);
    return new Date(utcTime.getTime() - tzOffset * 60000);
  } catch {
    return utcTime;
  }
}

/**
 * Get timezone offset in minutes for a given timezone and date.
 * Returns a negative value for timezones ahead of UTC (e.g. Asia/Manila UTC+8 → -480)
 * and a positive value for timezones behind UTC (e.g. America/New_York UTC-5 → +300).
 * Formula: (UTC wall-clock time) - (timezone wall-clock time), in minutes.
 */
export function getTimezoneOffset(timezone: string, date: Date): number {
  try {
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    return (utcDate.getTime() - tzDate.getTime()) / 60000;
  } catch {
    return 0;
  }
}

/**
 * Validate if a timezone string is valid IANA timezone
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

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
@Entity('attendance_records')
// Unique index
@Index('idx_attendance_record_number', ['tenantId', 'recordNumber'], { unique: true })
// Composite indexes for common query patterns
@Index('idx_attendance_tenant_employee', ['tenantId', 'employeeId'])
@Index('idx_attendance_tenant_date', ['tenantId', 'date'])
@Index('idx_attendance_status_tenant', ['status', 'tenantId'])
// Extended composite indexes
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

  @Field(() => Employee, { nullable: true })
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

  /**
   * IANA timezone string for the employee's local timezone
   * All clock times are stored in UTC but this field allows
   * proper local time display and shift calculations
   */
  @Field({ nullable: true })
  @Column({ length: 50, nullable: true, default: 'UTC' })
  timezone?: string;

  /**
   * Break start time - stored in UTC
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  breakStartTime?: Date;

  /**
   * Break end time - stored in UTC
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  breakEndTime?: Date;

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

  /**
   * Calculated total break minutes based on breakStartTime and breakEndTime
   * This is computed on load and not stored in the database
   */
  @Field(() => Int, { nullable: true })
  totalBreakMinutes?: number;

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
      // SECURITY: Use cryptographically secure random bytes instead of Math.random()
      // to prevent enumeration attacks on attendance record IDs (MED-01).
      const randomBytes = require('crypto').randomBytes(3);
      const random = (randomBytes.readUIntBE(0, 3) % 100000).toString().padStart(5, '0');
      this.recordNumber = `ATT-${year}${month}-${random}`;
    }
  }

  /**
   * Calculate totalBreakMinutes after loading from database.
   * Early-return when either time is null (the common case) avoids two unnecessary
   * Date allocations per row on bulk queries (M-8 fix).
   */
  @AfterLoad()
  calculateTotalBreakMinutes(): void {
    if (!this.breakStartTime || !this.breakEndTime) {
      // Fall back to stored breakMinutes if break times not recorded
      this.totalBreakMinutes = this.breakMinutes || 0;
      return;
    }
    const breakStart = new Date(this.breakStartTime);
    const breakEnd = new Date(this.breakEndTime);
    this.totalBreakMinutes = Math.max(0, Math.floor((breakEnd.getTime() - breakStart.getTime()) / 60000));
  }

  /**
   * Calculate actual worked minutes accounting for breaks and overnight shifts
   * @param clockIn - Clock in time (UTC)
   * @param clockOut - Clock out time (UTC)
   * @param breakMinutes - Total break time in minutes
   * @returns Net worked minutes
   */
  static calculateWorkedMinutes(clockIn: Date, clockOut: Date, breakMinutes: number = 0): number {
    const clockInTime = new Date(clockIn).getTime();
    const clockOutTime = new Date(clockOut).getTime();

    // Handle overnight shift: if clockOut is before clockIn on same day comparison,
    // it means the shift crossed midnight
    let totalMinutes = Math.floor((clockOutTime - clockInTime) / 60000);

    // Subtract break time
    const netMinutes = totalMinutes - breakMinutes;

    return Math.max(0, netMinutes);
  }

  /**
   * Get clock-in time converted to local timezone
   */
  getLocalClockIn(): Date | undefined {
    if (!this.clockIn || !this.timezone) return this.clockIn;
    return convertUtcToLocal(new Date(this.clockIn), this.timezone);
  }

  /**
   * Get clock-out time converted to local timezone
   */
  getLocalClockOut(): Date | undefined {
    if (!this.clockOut || !this.timezone) return this.clockOut;
    return convertUtcToLocal(new Date(this.clockOut), this.timezone);
  }
}
