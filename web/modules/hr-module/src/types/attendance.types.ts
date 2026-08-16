/**
 * Attendance Management domain types
 */

import type { PaginationResultV1 } from '@platform/pagination-contracts';
import type { BaseEntity, GeoLocation } from './common.types';
import type { Employee } from './employee.types';

// =====================
// Enums
// =====================

export enum AttendanceStatus {
  PRESENT = 'PRESENT',
  ABSENT = 'ABSENT',
  LATE = 'LATE',
  EARLY_LEAVE = 'EARLY_LEAVE',
  HALF_DAY = 'HALF_DAY',
  ON_LEAVE = 'ON_LEAVE',
  HOLIDAY = 'HOLIDAY',
  OFFSHORE = 'OFFSHORE',
  REST_DAY = 'REST_DAY',
  WORK_FROM_HOME = 'WORK_FROM_HOME',
}

export enum ClockMethod {
  MANUAL = 'MANUAL',
  BIOMETRIC = 'BIOMETRIC',
  CARD = 'CARD',
  GPS = 'GPS',
  WEB = 'WEB',
  MOBILE = 'MOBILE',
}

export enum DayOfWeek {
  MONDAY = 'MONDAY',
  TUESDAY = 'TUESDAY',
  WEDNESDAY = 'WEDNESDAY',
  THURSDAY = 'THURSDAY',
  FRIDAY = 'FRIDAY',
  SATURDAY = 'SATURDAY',
  SUNDAY = 'SUNDAY',
}

export enum ScheduleStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

// =====================
// Interfaces
// =====================

export interface BreakPeriod {
  name: string;
  startTime: string;
  endTime: string;
  isPaid: boolean;
}

export interface Shift extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  breakPeriods: BreakPeriod[];
  workDays: DayOfWeek[];
  isNightShift: boolean;
  isOffshoreShift: boolean;
  rotationDays?: number;
  colorCode?: string;
  isActive: boolean;
}

export interface Schedule extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  defaultShiftId: string;
  defaultShift?: Shift;
  status: ScheduleStatus;
  effectiveFrom: string;
  effectiveTo?: string;
  isDefault: boolean;
  entries?: ScheduleEntry[];
}

export interface ScheduleEntry extends BaseEntity {
  scheduleId: string;
  schedule?: Schedule;
  employeeId: string;
  employee?: Employee;
  shiftId: string;
  shift?: Shift;
  effectiveDate: string;
  notes?: string;
}

export interface AttendanceRecord extends BaseEntity {
  employeeId: string;
  employee?: Employee;
  date: string;
  scheduleId?: string;
  schedule?: Schedule;
  shiftId?: string;
  shift?: Shift;
  clockIn?: string;
  clockOut?: string;
  clockInMethod?: ClockMethod;
  clockOutMethod?: ClockMethod;
  clockInLocation?: GeoLocation;
  clockOutLocation?: GeoLocation;
  status: AttendanceStatus;
  isLate: boolean;
  lateMinutes: number;
  isEarlyDeparture: boolean;
  earlyLeaveMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  isOffshore: boolean;
  workAreaId?: string;
  remarks?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface AttendanceSummary {
  employeeId: string;
  employee?: Employee;
  month: number;
  year: number;
  // WHY: Matches the backend AttendanceSummary GraphQL field `totalWorkDays`
  // (get-attendance-summary.handler.ts). The previous name `totalWorkingDays`
  // did not exist on the type and produced a GraphQL field-selection drift.
  totalWorkDays: number;
  presentDays: number;
  absentDays: number;
  lateDays: number;
  leaveDays: number;
  offshoreDays: number;
  holidayDays: number;
  totalWorkedMinutes: number;
  totalOvertimeMinutes: number;
  attendanceRate: number;
}

export interface DailyAttendanceOverview {
  totalEmployees: number;
  present: number;
  absent: number;
  late: number;
  onLeave: number;
  offshore: number;
  attendanceRate: number;
}

// =====================
// Input Types
// =====================

export interface ClockInInput {
  employeeId: string;
  method: ClockMethod;
  location?: GeoLocation;
  workAreaId?: string;
  isOffshore?: boolean;
  remarks?: string;
}

export interface ClockOutInput {
  employeeId: string;
  method: ClockMethod;
  location?: GeoLocation;
  remarks?: string;
}

export interface CreateAttendanceRecordInput {
  employeeId: string;
  date: string;
  scheduleId?: string;
  shiftId?: string;
  clockIn?: string;
  clockOut?: string;
  status: AttendanceStatus;
  isOffshore?: boolean;
  workAreaId?: string;
  remarks?: string;
}

export interface UpdateAttendanceRecordInput {
  id: string;
  clockIn?: string;
  clockOut?: string;
  status?: AttendanceStatus;
  remarks?: string;
}

export interface CreateShiftInput {
  code: string;
  name: string;
  description?: string;
  startTime: string;
  endTime: string;
  graceMinutes?: number;
  breakPeriods?: BreakPeriod[];
  workDays: DayOfWeek[];
  isNightShift?: boolean;
  isOffshoreShift?: boolean;
  rotationDays?: number;
  colorCode?: string;
}

export interface AttendanceFilterInput {
  employeeId?: string;
  departmentId?: string;
  startDate?: string;
  endDate?: string;
  status?: AttendanceStatus;
  isOffshore?: boolean;
}

export interface AttendanceSummaryInput {
  employeeId: string;
  month: number;
  year: number;
}

// =====================
// Response Types
// =====================

export type AttendanceRecordConnection = PaginationResultV1<AttendanceRecord>;
export type ShiftConnection = PaginationResultV1<Shift>;

// =====================
// Display Helpers
// =====================

export const ATTENDANCE_STATUS_CONFIG: Record<AttendanceStatus, { label: string; variant: string }> = {
  [AttendanceStatus.PRESENT]: { label: 'Present', variant: 'success' },
  [AttendanceStatus.ABSENT]: { label: 'Absent', variant: 'error' },
  [AttendanceStatus.LATE]: { label: 'Late', variant: 'warning' },
  [AttendanceStatus.EARLY_LEAVE]: { label: 'Early Leave', variant: 'warning' },
  [AttendanceStatus.HALF_DAY]: { label: 'Half Day', variant: 'info' },
  [AttendanceStatus.ON_LEAVE]: { label: 'On Leave', variant: 'info' },
  [AttendanceStatus.HOLIDAY]: { label: 'Holiday', variant: 'default' },
  [AttendanceStatus.OFFSHORE]: { label: 'Offshore', variant: 'primary' },
  [AttendanceStatus.REST_DAY]: { label: 'Rest Day', variant: 'default' },
  [AttendanceStatus.WORK_FROM_HOME]: { label: 'WFH', variant: 'info' },
};

export const CLOCK_METHOD_LABELS: Record<ClockMethod, string> = {
  [ClockMethod.MANUAL]: 'Manual Entry',
  [ClockMethod.BIOMETRIC]: 'Biometric',
  [ClockMethod.CARD]: 'Card Swipe',
  [ClockMethod.GPS]: 'GPS Check-in',
  [ClockMethod.WEB]: 'Web Portal',
  [ClockMethod.MOBILE]: 'Mobile App',
};

export const DAY_OF_WEEK_LABELS: Record<DayOfWeek, string> = {
  [DayOfWeek.MONDAY]: 'Monday',
  [DayOfWeek.TUESDAY]: 'Tuesday',
  [DayOfWeek.WEDNESDAY]: 'Wednesday',
  [DayOfWeek.THURSDAY]: 'Thursday',
  [DayOfWeek.FRIDAY]: 'Friday',
  [DayOfWeek.SATURDAY]: 'Saturday',
  [DayOfWeek.SUNDAY]: 'Sunday',
};
