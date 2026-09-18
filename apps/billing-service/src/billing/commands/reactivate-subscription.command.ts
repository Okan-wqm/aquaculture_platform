/**
 * Un-cancel a subscription (ADR-0014, BILLING-CRITICAL-003).
 *
 * The admin path used to do this with a raw `UPDATE billing.subscriptions`
 * that touched no Stripe object, wrote no outbox event and projected nothing
 * onto `auth.tenants` — so a "reactivated" tenant kept its cancelled
 * entitlements and Stripe still stopped billing at period end.
 */
export class ReactivateSubscriptionCommand {
  constructor(
    public readonly tenantId: string,
    public readonly subscriptionId: string,
    public readonly userId: string,
  ) {}
}
