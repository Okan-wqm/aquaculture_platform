import { LeaveRequestStatus } from '../entities/leave-request.entity';

export class GetLeaveRequestsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId?: string,
    public readonly status?: LeaveRequestStatus,
    public readonly leaveTypeId?: string,
    public readonly startDate?: string,
    public readonly endDate?: string,
    public readonly limit?: number,
    public readonly offset?: number,
  ) {}
}
