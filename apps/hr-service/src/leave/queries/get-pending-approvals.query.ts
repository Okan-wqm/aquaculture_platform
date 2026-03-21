export class GetPendingApprovalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly approverId: string | null,
    public readonly departmentId?: string,
    public readonly limit: number = 20,
    public readonly page: number = 1,
  ) {}
}
