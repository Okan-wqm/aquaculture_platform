export class GetLeaveBalancesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
    public readonly year?: number,
    public readonly leaveTypeId?: string,
  ) {}
}
