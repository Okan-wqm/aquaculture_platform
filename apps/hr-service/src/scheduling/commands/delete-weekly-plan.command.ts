export class DeleteWeeklyPlanCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly weeklyPlanId: string,
  ) {}
}
