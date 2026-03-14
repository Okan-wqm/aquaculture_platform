import { ChangeSubscriptionPlanInput } from '../dto/change-subscription-plan.input';

export class ChangeSubscriptionPlanCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: ChangeSubscriptionPlanInput,
    public readonly userId: string,
  ) {}
}
