export class GetTeamPerformanceOverviewQuery {
  constructor(
    public readonly tenantId: string,
    public readonly departmentId: string,
  ) {}
}
