export * from './get-shifts.handler';
export * from './get-attendance-records.handler';
export * from './get-attendance-summary.handler';
export * from './get-pending-attendance-approvals.handler';
export * from './get-todays-attendance.handler';
export * from './get-daily-attendance-overview.handler';

import { GetShiftsHandler } from './get-shifts.handler';
import { GetAttendanceRecordsHandler } from './get-attendance-records.handler';
import { GetAttendanceSummaryHandler } from './get-attendance-summary.handler';
import { GetPendingAttendanceApprovalsHandler } from './get-pending-attendance-approvals.handler';
import { GetTodaysAttendanceHandler } from './get-todays-attendance.handler';
import { GetDailyAttendanceOverviewHandler } from './get-daily-attendance-overview.handler';

export const AttendanceQueryHandlers = [
  GetShiftsHandler,
  GetAttendanceRecordsHandler,
  GetAttendanceSummaryHandler,
  GetPendingAttendanceApprovalsHandler,
  GetTodaysAttendanceHandler,
  GetDailyAttendanceOverviewHandler,
];
