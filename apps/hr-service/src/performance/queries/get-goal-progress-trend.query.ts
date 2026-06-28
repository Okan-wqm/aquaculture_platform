export class GetGoalProgressTrendQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
    public readonly startDate: string,
    public readonly endDate: string,
  ) {}
}
