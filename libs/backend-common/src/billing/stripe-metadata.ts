/**
 * The one declaration of how this platform binds a tenant to a Stripe object
 * (ADR-0014, BILLING-CRITICAL-003).
 *
 * The producer (`StripeApiService`) writes the tenant id into Stripe metadata
 * under ONE key; every webhook consumer read it under a DIFFERENT one
 * (`metadata.tenantId`) and warn-and-returned when it was absent — which it
 * always was. Every Stripe webhook this platform received was therefore
 * discarded: no payment was recorded, no subscription was ever marked
 * PAST_DUE or CANCELLED from Stripe, and no refund reached a payment row.
 *
 * The producer's key is NOT renamed. Every Stripe object the platform has ever
 * created carries `internalTenantId`; renaming it would orphan all of them.
 * Both sides read this constant instead, so the two cannot drift again.
 *
 * ## The hint is not the authority (SECREV-CRITICAL-001)
 *
 * Stripe metadata is writable by anyone who can reach the Stripe account, so a
 * tenant id read out of it is an ASSOCIATION HINT, never proof. The
 * authoritative answer is the local row that owns the Stripe object — a
 * subscription found by its `stripe_subscription_id`, a payment by its
 * `stripe_payment_intent_id`. `readStripeTenantHint` exists to cross-check
 * that answer and to make a disagreement visible; it is never the answer.
 */

/** The metadata key the platform binds a tenant id under. Do NOT rename. */
export const STRIPE_TENANT_METADATA_KEY = 'internalTenantId';

/**
 * The tenant id a Stripe object claims, or `null`.
 *
 * A hint for cross-checking the authoritative lookup — see the file docblock.
 * Anything that is not a non-empty string is `null`: Stripe metadata values
 * are free-form strings supplied by whoever wrote them.
 */
export function readStripeTenantHint(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[STRIPE_TENANT_METADATA_KEY];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
