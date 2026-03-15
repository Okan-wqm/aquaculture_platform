import { GoalPriority } from '../entities/goal.entity';
import { KeyResultInput } from '../dto/create-goal.input';

export class CreateGoalCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly title: string,
    public readonly priority: GoalPriority,
    public readonly startDate: string,
    public readonly targetDate: string,
    public readonly description?: string,
    public readonly category?: string,
    public readonly keyResults?: KeyResultInput[],
    public readonly alignedReviewId?: string,
    public readonly parentGoalId?: string,
  ) {}
}
