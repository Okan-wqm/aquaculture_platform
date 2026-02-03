export class GetTeamWeeklyOverviewQuery {
  constructor(
    public readonly tenantId: string,
    public readonly weekStartDate: string,
    public readonly departmentId?: string,
    public readonly siteId?: string,
  ) {}
}
