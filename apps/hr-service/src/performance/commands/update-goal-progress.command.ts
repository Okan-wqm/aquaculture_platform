import { KeyResultUpdateInput } from '../dto/update-goal.input';

export class UpdateGoalProgressCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly goalId: string,
    public readonly progressPercent: number,
    public readonly keyResultUpdates?: KeyResultUpdateInput[],
    public readonly notes?: string,
  ) {}
}
