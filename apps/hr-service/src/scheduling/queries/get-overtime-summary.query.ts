export class GetOvertimeSummaryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly month: number,
    public readonly year: number,
    public readonly employeeId?: string,
    public readonly departmentId?: string,
  ) {}
}
