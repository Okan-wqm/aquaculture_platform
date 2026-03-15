export class DeferGoalCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly goalId: string,
    public readonly newTargetDate: string,
    public readonly reason?: string,
  ) {}
}
