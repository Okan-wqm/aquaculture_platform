export class CopyWeeklyPlanCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly sourceWeeklyPlanId: string,
    public readonly targetWeekStartDate: string,
  ) {}
}
