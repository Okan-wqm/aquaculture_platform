export * from './create-leave-request.handler';
export * from './submit-leave-request.handler';
export * from './approve-leave-request.handler';
export * from './reject-leave-request.handler';
export * from './cancel-leave-request.handler';

import { CreateLeaveRequestHandler } from './create-leave-request.handler';
import { SubmitLeaveRequestHandler } from './submit-leave-request.handler';
import { ApproveLeaveRequestHandler } from './approve-leave-request.handler';
import { RejectLeaveRequestHandler } from './reject-leave-request.handler';
import { CancelLeaveRequestHandler } from './cancel-leave-request.handler';

export const LeaveCommandHandlers = [
  CreateLeaveRequestHandler,
  SubmitLeaveRequestHandler,
  ApproveLeaveRequestHandler,
  RejectLeaveRequestHandler,
  CancelLeaveRequestHandler,
];
