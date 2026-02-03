export class PublishWeeklyPlanCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly weeklyPlanId: string,
  ) {}
}
