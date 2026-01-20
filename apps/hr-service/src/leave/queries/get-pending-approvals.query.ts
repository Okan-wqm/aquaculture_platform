export class GetPendingApprovalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly approverId: string,
    public readonly departmentId?: string,
  ) {}
}
