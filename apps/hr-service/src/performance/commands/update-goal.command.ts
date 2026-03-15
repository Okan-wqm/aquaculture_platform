import { GoalPriority, GoalStatus } from '../entities/goal.entity';

export class UpdateGoalCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly id: string,
    public readonly title?: string,
    public readonly description?: string,
    public readonly priority?: GoalPriority,
    public readonly targetDate?: string,
    public readonly status?: GoalStatus,
  ) {}
}
