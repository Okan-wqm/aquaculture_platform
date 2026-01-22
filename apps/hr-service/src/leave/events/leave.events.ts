import { LeaveRequest } from '../entities/leave-request.entity';

/**
 * Base class for leave request events
 */
export abstract class LeaveRequestEvent {
  constructor(public readonly leaveRequest: LeaveRequest) {}

  get requestId(): string {
    return this.leaveRequest.id;
  }

  get employeeId(): string {
    return this.leaveRequest.employeeId;
  }

  get tenantId(): string {
    return this.leaveRequest.tenantId;
  }
}

/**
 * Event published when a leave request is submitted for approval
 */
export class LeaveRequestSubmittedEvent extends LeaveRequestEvent {
  readonly eventType = 'leave.request.submitted';
}

/**
 * Event published when a leave request is approved
 */
export class LeaveApprovedEvent extends LeaveRequestEvent {
  readonly eventType = 'leave.request.approved';

  get approvedBy(): string | undefined {
    return this.leaveRequest.approvedBy;
  }
}

/**
 * Event published when a leave request is rejected
 */
export class LeaveRejectedEvent extends LeaveRequestEvent {
  readonly eventType = 'leave.request.rejected';

  get rejectedBy(): string | undefined {
    return this.leaveRequest.rejectedBy;
  }

  get rejectionReason(): string | undefined {
    return this.leaveRequest.rejectionReason;
  }
}

/**
 * Event published when a leave request is cancelled
 */
export class LeaveCancelledEvent extends LeaveRequestEvent {
  readonly eventType = 'leave.request.cancelled';

  get cancelledBy(): string | undefined {
    return this.leaveRequest.cancelledBy;
  }

  get cancellationReason(): string | undefined {
    return this.leaveRequest.cancellationReason;
  }
}
