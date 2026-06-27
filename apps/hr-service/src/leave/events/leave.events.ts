import { toEventIso, createBaseEvent } from '@platform/event-contracts';
import type {
  LeaveRequestSubmittedEvent,
  LeaveApprovedEvent,
  LeaveRejectedEvent,
  LeaveCancelledEvent,
} from '@platform/event-contracts';
import { LeaveRequest } from '../entities/leave-request.entity';

/**
 * Create a flat LeaveRequestSubmittedEvent conforming to the event-contracts interface.
 * eventType is PascalCase per the BaseEvent contract.
 */
export function createLeaveRequestSubmittedEvent(
  leaveRequest: LeaveRequest,
): LeaveRequestSubmittedEvent {
  return {
    ...createBaseEvent<LeaveRequestSubmittedEvent>(
      'LeaveRequestSubmitted',
      leaveRequest.tenantId,
    ),
    eventType: 'LeaveRequestSubmitted' as const,
    leaveRequestId: leaveRequest.id,
    employeeId: leaveRequest.employeeId,
    leaveTypeId: leaveRequest.leaveTypeId,
    leaveTypeName: leaveRequest.leaveType?.name ?? 'Unknown',
    startDate: toEventIso(leaveRequest.startDate),
    endDate: toEventIso(leaveRequest.endDate),
    totalDays: Number(leaveRequest.totalDays),
  };
}

/**
 * Create a flat LeaveApprovedEvent conforming to the event-contracts interface.
 */
export function createLeaveApprovedEvent(
  leaveRequest: LeaveRequest,
  approvedBy: string,
): LeaveApprovedEvent {
  return {
    ...createBaseEvent<LeaveApprovedEvent>('LeaveApproved', leaveRequest.tenantId),
    eventType: 'LeaveApproved' as const,
    leaveId: leaveRequest.id,
    employeeId: leaveRequest.employeeId,
    approvedBy,
  };
}

/**
 * Create a flat LeaveRejectedEvent conforming to the event-contracts interface.
 */
export function createLeaveRejectedEvent(
  leaveRequest: LeaveRequest,
  rejectedBy: string,
  reason: string,
): LeaveRejectedEvent {
  return {
    ...createBaseEvent<LeaveRejectedEvent>('LeaveRejected', leaveRequest.tenantId),
    eventType: 'LeaveRejected' as const,
    leaveRequestId: leaveRequest.id,
    employeeId: leaveRequest.employeeId,
    rejectedBy,
    reason,
  };
}

/**
 * Create a flat LeaveCancelledEvent conforming to the event-contracts interface.
 */
export function createLeaveCancelledEvent(
  leaveRequest: LeaveRequest,
  cancelledBy: string,
  reason?: string,
): LeaveCancelledEvent {
  return {
    ...createBaseEvent<LeaveCancelledEvent>('LeaveCancelled', leaveRequest.tenantId),
    eventType: 'LeaveCancelled' as const,
    leaveRequestId: leaveRequest.id,
    employeeId: leaveRequest.employeeId,
    cancelledBy,
    reason,
  };
}
