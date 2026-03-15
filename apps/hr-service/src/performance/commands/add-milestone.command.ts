import { MilestoneInput } from '../dto/create-goal.input';

export class AddMilestoneCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly goalId: string,
    public readonly milestone: MilestoneInput,
  ) {}
}
