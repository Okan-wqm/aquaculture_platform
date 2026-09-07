/**
 * A tenant's Stripe objects are minted in one place (BILLING-CRITICAL-010).
 *
 * Two paths create a subscription. `CreateSubscriptionHandler` (GraphQL) minted
 * a Stripe customer and subscription; `BillingAdminNatsHandler` (operator
 * provisioning) raw-INSERTed into `billing.subscriptions` with
 * `stripe_customer_id` and `stripe_subscription_id` omitted from the column
 * list entirely. They landed NULL and nothing ever filled them, because the
 * only writer of those columns was the path the operator flow does not use.
 *
 * Every operator-provisioned tenant therefore had a subscription this platform
 * believed in and Stripe had never heard of: nothing charged them, and two of
 * the five inbound webhook handlers resolve the tenant from
 * `stripe_subscription_id`, so those stayed inert for them too.
 *
 * The obvious repair — copy the mint into the second handler — is the defect
 * class this repo just paid for in BILLING-CRITICAL-007, where a price rule
 * written twice in two services disagreed and nobody noticed. So the mint lives
 * in `StripeSubscriptionProvisionerService` and this gate keeps it there:
 * outside that file, no billing code calls `createCustomer` or
 * `createSubscription` on the Stripe client.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** billing-service owns subscription creation. */
const SCANNED_ROOT = 'apps/billing-service/src';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', '.nx', '.archive']);

/** The one file allowed to mint. */
const MINT_DECLARATION =
  'apps/billing-service/src/billing/services/stripe-subscription-provisioner.service.ts';

/**
 * A call to the canonical Stripe client's subscription-creating surface.
 * Anchored on the method names rather than the injected field name, so renaming
 * the field does not slip a second mint past this gate.
 */
const STRIPE_MINT_CALL = /\.\s*(createCustomer|createSubscription)\s*\(/;

function sourceFiles(dirAbs: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(childAbs));
    } else if (
      entry.isFile() &&
      extname(entry.name) === '.ts' &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(childAbs);
    }
  }
  return out;
}

describe('INVARIANT: one place mints a tenant’s Stripe objects', () => {
  const files = sourceFiles(resolve(REPO_ROOT, SCANNED_ROOT));

  it('scans the service it is meant to govern', () => {
    // A walker that matched nothing would make the cases below vacuous.
    expect(files.length).toBeGreaterThan(50);
  });

  it('mints in exactly one file', () => {
    const offenders: string[] = [];

    for (const fileAbs of files) {
      const relPath = relative(REPO_ROOT, fileAbs);
      if (relPath === MINT_DECLARATION) continue;
      readFileSync(fileAbs, 'utf-8')
        .split('\n')
        .forEach((line, index) => {
          if (STRIPE_MINT_CALL.test(line)) {
            offenders.push(`${relPath}:${index + 1}: ${line.trim()}`);
          }
        });
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} site(s) mint Stripe objects outside ${MINT_DECLARATION}. A second ` +
          `copy is how the idempotency keys and the no-price rule drift apart, and how one ` +
          `subscription path came to write the ids while the other left them NULL. Call ` +
          `StripeSubscriptionProvisionerService.ensureStripeObjects instead:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('writes both Stripe columns wherever it INSERTs a subscription', () => {
    // The defect was not a wrong value — it was a column list that omitted the
    // two columns, so no value could be wrong. A raw INSERT into
    // billing.subscriptions must name both or it is that bug again.
    const offenders: string[] = [];

    for (const fileAbs of files) {
      const contents = readFileSync(fileAbs, 'utf-8');
      if (!/INSERT\s+INTO\s+billing\.subscriptions/i.test(contents)) continue;
      const relPath = relative(REPO_ROOT, fileAbs);
      for (const column of ['stripe_customer_id', 'stripe_subscription_id']) {
        if (!contents.includes(column)) {
          offenders.push(`${relPath}: INSERT INTO billing.subscriptions omits ${column}`);
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} raw subscription INSERT(s) omit a Stripe id column, which is how ` +
          `operator-provisioned tenants came to carry NULLs nothing could fill:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('matches a mint call and leaves unrelated Stripe reads alone', () => {
    expect(STRIPE_MINT_CALL.test('const c = await this.stripeApi.createCustomer({')).toBe(true);
    expect(STRIPE_MINT_CALL.test('await this.stripe.createSubscription({ priceId })')).toBe(true);
    // Reads, refunds and cancellations are not a mint and are not in scope.
    expect(STRIPE_MINT_CALL.test('await this.stripeApi.createRefund({ chargeId })')).toBe(false);
    expect(STRIPE_MINT_CALL.test('await this.stripeApi.cancelSubscription({ id })')).toBe(false);
  });
});
