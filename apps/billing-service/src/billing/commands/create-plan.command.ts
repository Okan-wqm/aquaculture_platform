import { CreatePlanInput } from '../dto/create-plan.input';

export class CreatePlanCommand {
  constructor(
    public readonly input: CreatePlanInput,
    public readonly userId: string,
  ) {}
}
