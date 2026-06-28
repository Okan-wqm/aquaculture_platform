export * from './get-leave-types.handler';
export * from './get-leave-balances.handler';
export * from './get-leave-requests.handler';
export * from './get-leave-request-by-id.handler';
export * from './get-pending-approvals.handler';
export * from './get-team-leave-calendar.handler';
export * from './check-leave-overlap.handler';
export * from './calculate-leave-days.handler';

import { GetLeaveTypesHandler } from './get-leave-types.handler';
import { GetLeaveBalancesHandler } from './get-leave-balances.handler';
import { GetLeaveRequestsHandler } from './get-leave-requests.handler';
import { GetLeaveRequestByIdHandler } from './get-leave-request-by-id.handler';
import { GetPendingApprovalsHandler } from './get-pending-approvals.handler';
import { GetTeamLeaveCalendarHandler } from './get-team-leave-calendar.handler';
import { CheckLeaveOverlapHandler } from './check-leave-overlap.handler';
import { CalculateLeaveDaysHandler } from './calculate-leave-days.handler';

export const LeaveQueryHandlers = [
  GetLeaveTypesHandler,
  GetLeaveBalancesHandler,
  GetLeaveRequestsHandler,
  GetLeaveRequestByIdHandler,
  GetPendingApprovalsHandler,
  GetTeamLeaveCalendarHandler,
  CheckLeaveOverlapHandler,
  CalculateLeaveDaysHandler,
];
