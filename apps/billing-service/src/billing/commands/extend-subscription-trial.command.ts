/**
 * Move a trial's end date out (ADR-0014, BILLING-CRITICAL-003).
 *
 * The admin path used to do this with a raw `UPDATE billing.subscriptions`
 * that left Stripe charging on the ORIGINAL trial end date, so a tenant given
 * another fourteen days was invoiced on day one of them.
 */
export class ExtendSubscriptionTrialCommand {
  constructor(
    public readonly tenantId: string,
    public readonly subscriptionId: string,
    public readonly additionalDays: number,
    public readonly userId: string,
  ) {}
}
