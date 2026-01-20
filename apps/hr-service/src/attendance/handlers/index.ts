export * from './clock-in.handler';
export * from './clock-out.handler';
export * from './create-shift.handler';
export * from './create-manual-attendance.handler';
export * from './approve-attendance.handler';

import { ClockInHandler } from './clock-in.handler';
import { ClockOutHandler } from './clock-out.handler';
import { CreateShiftHandler } from './create-shift.handler';
import { CreateManualAttendanceHandler } from './create-manual-attendance.handler';
import { ApproveAttendanceHandler } from './approve-attendance.handler';

export const AttendanceCommandHandlers = [
  ClockInHandler,
  ClockOutHandler,
  CreateShiftHandler,
  CreateManualAttendanceHandler,
  ApproveAttendanceHandler,
];
