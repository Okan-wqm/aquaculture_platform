/**
 * Cancel a subscription.
 *
 * `cancelImmediately` is the difference between ending the service now and
 * letting the customer keep what they paid for until period end. ADR-0014
 * brought the admin path onto this command; that path had always offered the
 * choice, through a raw `UPDATE` that told Stripe nothing either way.
 */
export class CancelSubscriptionCommand {
  constructor(
    public readonly tenantId: string,
    public readonly subscriptionId: string,
    public readonly reason: string,
    public readonly userId: string,
    /** Default: cancel at period end, which is what the customer paid for. */
    public readonly cancelImmediately: boolean = false,
  ) {}
}
