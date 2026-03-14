import { UpdatePlanInput } from '../dto/update-plan.input';

export class UpdatePlanCommand {
  constructor(
    public readonly planId: string,
    public readonly input: UpdatePlanInput,
    public readonly userId: string,
  ) {}
}
