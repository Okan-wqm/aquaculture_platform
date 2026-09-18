/**
 * Canonical Stripe metadata contract.
 *
 * # Why this module exists
 *
 * `StripeApiService` binds the internal tenant id into the metadata of
 * every Stripe object it creates, and inbound webhook handlers want to
 * read it back. Two sides, one wire key — but the key was a bare string
 * literal on the producer (`internalTenantId`) and a *different* bare
 * string literal on the consumer (`tenantId`). Nothing connected them,
 * so the drift was invisible to the compiler and to every test: each
 * side was internally consistent and the pair was silently broken.
 * Exporting the key as a constant both sides import makes that specific
 * drift impossible.
 *
 * # Why the value is a HINT and never the tenant
 *
 * Stripe metadata is writable by anyone who can reach the Stripe
 * account — dashboard operators, API keys, and any integration sharing
 * the account. A tenant id read out of it is therefore an *association
 * hint*, never proof of ownership (SECREV-CRITICAL-001). Webhook
 * handlers MUST resolve the tenant from the local row that owns the
 * Stripe object (a payment by its payment-intent id, an invoice by its
 * Stripe invoice id, a subscription by its Stripe subscription id) and
 * use this hint only to cross-check that resolution.
 */

/**
 * The metadata key `StripeApiService` writes the internal tenant id under.
 *
 * Declared `as const` so the computed-property write site is typed as
 * this literal, not as `string`.
 */
export const STRIPE_TENANT_METADATA_KEY = 'internalTenantId' as const;

/**
 * Reads the tenant association hint out of an inbound Stripe object's
 * metadata. Returns `undefined` for anything that is not a non-empty
 * string — inbound webhook payloads are untyped JSON, so a missing key,
 * a null, or a number are all "no hint" rather than an error.
 *
 * The result is a hint for cross-checking only. Never assign it to a
 * `tenantId` used for a write; see the module header.
 */
export function readStripeTenantHint(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[STRIPE_TENANT_METADATA_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
