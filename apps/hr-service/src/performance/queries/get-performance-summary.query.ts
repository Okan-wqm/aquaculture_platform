export class GetPerformanceSummaryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
  ) {}
}
