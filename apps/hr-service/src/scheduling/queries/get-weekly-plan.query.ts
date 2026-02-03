export class GetWeeklyPlanQuery {
  constructor(
    public readonly tenantId: string,
    public readonly weeklyPlanId: string,
  ) {}
}
