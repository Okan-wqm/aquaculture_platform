export class GetPendingAttendanceApprovalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly approverId: string,
    public readonly departmentId?: string,
  ) {}
}
