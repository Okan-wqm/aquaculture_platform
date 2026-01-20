import { CreateSubscriptionInput } from '../dto/create-subscription.input';

export class CreateSubscriptionCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateSubscriptionInput,
    public readonly userId: string,
  ) {}
}
