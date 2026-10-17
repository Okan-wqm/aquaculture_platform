import type { PaginationResultV1 } from '@platform/pagination-contracts';
import type {
  DayEntry as WireDayEntry,
  DaySummary as WireDaySummary,
  EmployeeWeekSummary as WireEmployeeWeekSummary,
  TeamWeeklyOverview as WireTeamWeeklyOverview,
  WeekDay as WireWeekDay,
  WeeklyPlanEntryType as WireWeeklyPlanEntryType,
  WeeklyPlanStatus as WireWeeklyPlanStatus,
} from '@platform/shared-ui/generated/graphql-types';

/**
 * Scheduling Types for Workforce Planning
 *
 * WHY the enums and the teamWeeklyOverview shapes are derived from shared-ui's
 * generated graphql-types (codegen over the composed supergraph) instead of
 * hand-written: hr-service registers WeekDay, WeeklyPlanStatus and
 * WeeklyPlanEntryType with registerEnumType, so the wire carries the enum NAME
 * (MONDAY, PUBLISHED, WORK), not the entity's lower-case column value. The
 * hand-written lower-case unions matched nothing on the wire — every
 * day-of-week lookup and entry-type branch fell through — and declared the
 * nullable fields as `?: string`, while graphql-js sends an absent value as
 * `null` (teamWeeklyOverview's OFF filler days carry no shift or times). Deriving
 * them lets tsc catch both drifts instead of the UI.
 */

export type WeekDay = WireWeekDay;

/**
 * WeeklyPlan.status is the WeeklyPlanStatus enum (DRAFT | PUBLISHED | CLOSED).
 * NOTE: EmployeeWeekSummary.planStatus is a plain String field that carries
 * the column value ('draft' | 'published' | 'closed') — a different spelling of
 * the same state (get-team-weekly-overview.handler.ts).
 */
export type WeeklyPlanStatus = WireWeeklyPlanStatus;

export type WeeklyPlanEntryType = WireWeeklyPlanEntryType;

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

// teamWeeklyOverview — GET_TEAM_WEEKLY_OVERVIEW selects every field of these
// types, so the generated shapes are exactly what the query returns.
export type DayEntry = WireDayEntry;
export type EmployeeWeekSummary = WireEmployeeWeekSummary;
export type DaySummary = WireDaySummary;
export type TeamWeeklyOverview = WireTeamWeeklyOverview;

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
