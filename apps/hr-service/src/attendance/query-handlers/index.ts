export * from './get-shifts.handler';
export * from './get-attendance-records.handler';
export * from './get-attendance-summary.handler';
export * from './get-pending-attendance-approvals.handler';

import { GetShiftsHandler } from './get-shifts.handler';
import { GetAttendanceRecordsHandler } from './get-attendance-records.handler';
import { GetAttendanceSummaryHandler } from './get-attendance-summary.handler';
import { GetPendingAttendanceApprovalsHandler } from './get-pending-attendance-approvals.handler';

export const AttendanceQueryHandlers = [
  GetShiftsHandler,
  GetAttendanceRecordsHandler,
  GetAttendanceSummaryHandler,
  GetPendingAttendanceApprovalsHandler,
];
