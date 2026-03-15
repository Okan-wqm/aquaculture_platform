import { KeyResultInput } from '../dto/create-goal.input';

export class AddKeyResultCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly goalId: string,
    public readonly keyResult: KeyResultInput,
  ) {}
}
