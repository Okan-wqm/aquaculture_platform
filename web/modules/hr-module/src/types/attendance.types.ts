/**
 * Attendance Management domain types
 */

import type { BaseEntity, PaginatedResponse, GeoLocation } from './common.types';
import type { Employee } from './employee.types';

// =====================
// Enums
// =====================

export enum AttendanceStatus {
  PRESENT = 'present',
  ABSENT = 'absent',
  LATE = 'late',
  EARLY_DEPARTURE = 'early_departure',
  HALF_DAY = 'half_day',
  ON_LEAVE = 'on_leave',
  HOLIDAY = 'holiday',
  OFFSHORE = 'offshore',
  SICK = 'sick',
  WORK_FROM_HOME = 'work_from_home',
}

export enum ClockMethod {
  MANUAL = 'manual',
  BIOMETRIC = 'biometric',
  CARD = 'card',
  GPS = 'gps',
  WEB = 'web',
  MOBILE = 'mobile',
}

export enum DayOfWeek {
  MONDAY = 'monday',
  TUESDAY = 'tuesday',
  WEDNESDAY = 'wednesday',
  THURSDAY = 'thursday',
  FRIDAY = 'friday',
  SATURDAY = 'saturday',
  SUNDAY = 'sunday',
}

export enum ScheduleStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
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
  attendanceDate: string;
  scheduleId?: string;
  schedule?: Schedule;
  shiftId?: string;
  shift?: Shift;
  clockInTime?: string;
  clockOutTime?: string;
  clockInMethod?: ClockMethod;
  clockOutMethod?: ClockMethod;
  clockInLocation?: GeoLocation;
  clockOutLocation?: GeoLocation;
  status: AttendanceStatus;
  isLate: boolean;
  lateMinutes: number;
  isEarlyDeparture: boolean;
  earlyDepartureMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  isOffshoreWork: boolean;
  workAreaId?: string;
  notes?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface AttendanceSummary {
  employeeId: string;
  employee?: Employee;
  month: number;
  year: number;
  totalWorkingDays: number;
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
  date: string;
  totalEmployees: number;
  presentCount: number;
  absentCount: number;
  onLeaveCount: number;
  offshoreCount: number;
  lateCount: number;
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
  isOffshoreWork?: boolean;
  notes?: string;
}

export interface ClockOutInput {
  employeeId: string;
  method: ClockMethod;
  location?: GeoLocation;
  notes?: string;
}

export interface CreateAttendanceRecordInput {
  employeeId: string;
  attendanceDate: string;
  scheduleId?: string;
  shiftId?: string;
  clockInTime?: string;
  clockOutTime?: string;
  status: AttendanceStatus;
  isOffshoreWork?: boolean;
  workAreaId?: string;
  notes?: string;
}

export interface UpdateAttendanceRecordInput {
  id: string;
  clockInTime?: string;
  clockOutTime?: string;
  status?: AttendanceStatus;
  notes?: string;
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
  isOffshoreWork?: boolean;
}

export interface AttendanceSummaryInput {
  employeeId: string;
  month: number;
  year: number;
}

// =====================
// Response Types
// =====================

export type AttendanceRecordConnection = PaginatedResponse<AttendanceRecord>;
export type ShiftConnection = PaginatedResponse<Shift>;

// =====================
// Display Helpers
// =====================

export const ATTENDANCE_STATUS_CONFIG: Record<AttendanceStatus, { label: string; variant: string }> = {
  [AttendanceStatus.PRESENT]: { label: 'Present', variant: 'success' },
  [AttendanceStatus.ABSENT]: { label: 'Absent', variant: 'error' },
  [AttendanceStatus.LATE]: { label: 'Late', variant: 'warning' },
  [AttendanceStatus.EARLY_DEPARTURE]: { label: 'Early Departure', variant: 'warning' },
  [AttendanceStatus.HALF_DAY]: { label: 'Half Day', variant: 'info' },
  [AttendanceStatus.ON_LEAVE]: { label: 'On Leave', variant: 'info' },
  [AttendanceStatus.HOLIDAY]: { label: 'Holiday', variant: 'default' },
  [AttendanceStatus.OFFSHORE]: { label: 'Offshore', variant: 'primary' },
  [AttendanceStatus.SICK]: { label: 'Sick', variant: 'error' },
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
