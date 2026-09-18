/**
 * An inbound Stripe payload never supplies the tenant (SECREV-CRITICAL-001).
 *
 * `StripeApiService` binds the internal tenant id into the metadata of the
 * Stripe objects it creates, and every webhook handler in billing-service used
 * to read it back as `paymentIntent.metadata?.tenantId`. Two failures rode on
 * that one line:
 *
 *   1. The producer writes `internalTenantId`. The consumers read `tenantId`.
 *      Nothing connected the two literals, so the drift was invisible to the
 *      compiler and to every test — each side was internally consistent, and
 *      the pair was silently broken. Every webhook warned and returned: no
 *      payment recorded, no subscription moved to PAST_DUE or CANCELLED, no
 *      refund reaching a payment row.
 *
 *   2. Renaming the read would have cured the symptom and kept the flaw.
 *      Stripe metadata is writable by anyone who can reach the Stripe account,
 *      so a tenant id read out of it is an association hint, never proof of
 *      ownership. Handlers resolve the tenant from the LOCAL row that owns the
 *      Stripe object and use the hint only to cross-check.
 *
 * Rule 1 keeps billing-service off the payload as a tenant source. Rule 2 keeps
 * the wire key spelled in exactly one place, so failure 1 cannot recur in the
 * other direction either.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * billing-service owns every inbound provider webhook. The rule is scoped to
 * it on purpose: a `metadata.tenantId` read on an internally-constructed
 * object (GDPR consent metadata, for one) is a different value under the same
 * spelling, and a repo-wide ban would fail on code it cannot defend.
 */
const WEBHOOK_ROOT = 'apps/billing-service/src';

/** Roots that must not respell the wire key. */
const KEY_SPELLING_ROOTS = ['apps', 'libs', 'platform'] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', '.nx', '.archive']);

/** The one file allowed to spell the wire key: its declaration. */
const KEY_DECLARATION = 'libs/backend-common/src/billing/stripe-metadata.ts';

/**
 * `metadata.tenantId`, `metadata?.tenantId`, `metadata['tenantId']` — a tenant
 * identity pulled straight out of an inbound payload's metadata bag.
 */
const TENANT_FROM_METADATA =
  /\bmetadata\s*\??\s*(?:\.\s*tenant_?[iI]d\b|\[\s*['"]tenant_?[iI]d['"]\s*\])/;

/** The wire key written as a bare literal instead of imported as a constant. */
const BARE_KEY_LITERAL = /['"]internalTenantId['"]/;

function sourceFiles(dirAbs: string, includeSpecs: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(childAbs, includeSpecs));
    } else if (
      entry.isFile() &&
      extname(entry.name) === '.ts' &&
      (includeSpecs || !entry.name.endsWith('.spec.ts'))
    ) {
      out.push(childAbs);
    }
  }
  return out;
}

function scan(files: string[], pattern: RegExp, allow: (relPath: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const fileAbs of files) {
    const relPath = relative(REPO_ROOT, fileAbs);
    if (allow(relPath)) continue;
    readFileSync(fileAbs, 'utf-8')
      .split('\n')
      .forEach((line, index) => {
        if (pattern.test(line)) {
          offenders.push(`${relPath}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  return offenders;
}

describe('INVARIANT: the tenant comes from the local ledger, not the Stripe payload', () => {
  const webhookFiles = sourceFiles(resolve(REPO_ROOT, WEBHOOK_ROOT), false);
  const keyFiles = KEY_SPELLING_ROOTS.flatMap((root) =>
    sourceFiles(resolve(REPO_ROOT, root), false),
  );

  it('scans the source it is meant to govern', () => {
    // A walker that matched nothing would make both cases below vacuous.
    expect(webhookFiles.length).toBeGreaterThan(50);
    expect(keyFiles.length).toBeGreaterThan(1_000);
  });

  it('never reads a tenant id out of an inbound payload', () => {
    const offenders = scan(webhookFiles, TENANT_FROM_METADATA, () => false);

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} read(s) take the tenant from provider-supplied metadata. ` +
          `Stripe metadata is writable by anyone who can reach the Stripe account, so it ` +
          `identifies nothing. Resolve the tenant from the local row that owns the Stripe ` +
          `object (Payment by stripePaymentIntentId / stripeChargeId, Invoice by ` +
          `stripeInvoiceId, Subscription by stripeSubscriptionId) and pass the payload's ` +
          `metadata to readStripeTenantHint() for a cross-check only:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('spells the metadata wire key in exactly one place', () => {
    const offenders = scan(keyFiles, BARE_KEY_LITERAL, (relPath) => relPath === KEY_DECLARATION);

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} site(s) hardcode the Stripe tenant metadata key. Import ` +
          `STRIPE_TENANT_METADATA_KEY from @aquaculture/backend-common/billing so the ` +
          `producer and the consumers cannot drift apart again:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('matches the read it bans and leaves an outbound write alone', () => {
    expect(TENANT_FROM_METADATA.test('const t = paymentIntent.metadata?.tenantId;')).toBe(true);
    expect(TENANT_FROM_METADATA.test("const t = charge.metadata['tenantId'];")).toBe(true);
    expect(TENANT_FROM_METADATA.test('const t = invoice.metadata.tenant_id;')).toBe(true);
    // Writing the tenant INTO metadata on the way out is the producer's job.
    expect(
      TENANT_FROM_METADATA.test('metadata: { ...args.metadata, tenantId: args.tenantId }'),
    ).toBe(false);
    // Resolution from the owning local row is the cure, not the defect.
    expect(TENANT_FROM_METADATA.test('const tenantId = subscription.tenantId;')).toBe(false);
  });
});
