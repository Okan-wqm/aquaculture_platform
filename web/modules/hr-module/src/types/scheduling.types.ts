import type { PaginationResultV1 } from '@platform/pagination-contracts';

/**
 * Scheduling Types for Workforce Planning
 */

export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export type WeeklyPlanStatus = 'draft' | 'published';

export type WeeklyPlanEntryType = 'work' | 'off' | 'leave' | 'holiday' | 'training';

export interface SchedulingSettings {
  tenantId: string;
  standardWeeklyMinutes: number;
  maxOvertimeMinutesPerWeek: number;
  maxOvertimeMinutesPerMonth: number;
  defaultShiftId?: string;
  workWeekStartDay: WeekDay;
  autoNotifyEmployees: boolean;
  notifyDaysBefore: number;
  maxConsecutiveWorkDays: number;
  minRestMinutesBetweenShifts: number;
  allowOvertimeWithoutApproval: boolean;
}

export interface WeeklyPlan {
  id: string;
  tenantId: string;
  employeeId: string;
  employee?: {
    id: string;
    firstName: string;
    lastName: string;
    position?: string;
  };
  weekStartDate: string;
  weekEndDate: string;
  status: WeeklyPlanStatus;
  plannedWorkDays: number;
  plannedOffDays: number;
  plannedTotalMinutes: number;
  standardWeeklyMinutes: number;
  plannedOvertimeMinutes: number;
  actualOvertimeMinutes: number;
  notifiedAt?: string;
  publishedAt?: string;
  notes?: string;
  entries?: WeeklyPlanEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyPlanEntry {
  id: string;
  weeklyPlanId: string;
  employeeId: string;
  date: string;
  dayOfWeek: WeekDay;
  shiftId?: string;
  shift?: {
    id: string;
    code: string;
    name: string;
    startTime: string;
    endTime: string;
    colorCode?: string;
  };
  isOffDay: boolean;
  isLeaveDay: boolean;
  leaveRequestId?: string;
  plannedStartTime?: string;
  plannedEndTime?: string;
  plannedMinutes: number;
  entryType: WeeklyPlanEntryType;
  notes?: string;
}

export type WeeklyPlanConnection = PaginationResultV1<WeeklyPlan>;

export interface DayEntry {
  dayOfWeek: WeekDay;
  date: string;
  entryType: WeeklyPlanEntryType;
  shiftCode?: string;
  shiftName?: string;
  startTime?: string;
  endTime?: string;
  plannedMinutes: number;
}

export interface EmployeeWeekSummary {
  employeeId: string;
  employeeName: string;
  position?: string;
  weeklyPlanId?: string;
  planStatus?: string;
  days: DayEntry[];
  totalWorkDays: number;
  totalMinutes: number;
  overtimeMinutes: number;
}

export interface DaySummary {
  dayOfWeek: WeekDay;
  date: string;
  workingCount: number;
  offCount: number;
  leaveCount: number;
}

export interface TeamWeeklyOverview {
  weekStartDate: string;
  weekEndDate: string;
  totalEmployees: number;
  employeePlans: EmployeeWeekSummary[];
  daysSummary: DaySummary[];
}

export interface EmployeeOvertimeSummary {
  employeeId: string;
  employeeName: string;
  plannedOvertimeMinutes: number;
  actualOvertimeMinutes: number;
  weekCount: number;
}

export interface OvertimeSummary {
  month: number;
  year: number;
  totalPlannedOvertimeMinutes: number;
  totalActualOvertimeMinutes: number;
  employeeCount: number;
  byEmployee: EmployeeOvertimeSummary[];
}

export interface BulkAssignResult {
  success: boolean;
  updatedCount: number;
  errors: string[];
}

// Input types
export interface CreateWeeklyPlanInput {
  employeeId: string;
  weekStartDate: string;
  defaultShiftId?: string;
  defaultOffDays?: WeekDay[];
  notes?: string;
}

export interface UpdatePlanEntryInput {
  entryId: string;
  shiftId?: string;
  isOffDay?: boolean;
  plannedStartTime?: string;
  plannedEndTime?: string;
  entryType?: WeeklyPlanEntryType;
  notes?: string;
}

export interface ShiftAssignmentInput {
  date: string;
  shiftId?: string;
  isOffDay: boolean;
}

export interface BulkAssignShiftsInput {
  weeklyPlanId: string;
  assignments: ShiftAssignmentInput[];
}

export interface UpdateSchedulingSettingsInput {
  standardWeeklyMinutes?: number;
  maxOvertimeMinutesPerWeek?: number;
  maxOvertimeMinutesPerMonth?: number;
  defaultShiftId?: string;
  workWeekStartDay?: WeekDay;
  autoNotifyEmployees?: boolean;
  notifyDaysBefore?: number;
  maxConsecutiveWorkDays?: number;
  minRestMinutesBetweenShifts?: number;
  allowOvertimeWithoutApproval?: boolean;
}

// Filter types
export interface WeeklyPlanFilter {
  employeeId?: string;
  departmentId?: string;
  siteId?: string;
  weekStartDate?: string;
  status?: WeeklyPlanStatus;
}
