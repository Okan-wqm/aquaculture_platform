export class GetPendingAttendanceApprovalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly approverId: string,
    public readonly departmentId?: string,
    public readonly limit: number = 20,
    public readonly offset: number = 0,
  ) {}
}
