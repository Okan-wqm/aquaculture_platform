export class CancelSubscriptionCommand {
  constructor(
    public readonly tenantId: string,
    public readonly subscriptionId: string,
    public readonly reason: string,
    public readonly userId: string,
  ) {}
}
