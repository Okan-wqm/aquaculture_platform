export class CompleteMilestoneCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly goalId: string,
    public readonly milestoneId: string,
  ) {}
}
