/**
 * Platform-wide invariant — BILLING-CRITICAL-001:
 *
 * The canonical StripeApiService at
 * `libs/backend-common/src/billing/stripe-api.service.ts` is the ONLY
 * permitted callsite for outbound Stripe traffic. Every other reference
 * to the `stripe` SDK in production code is a CI fail.
 *
 * # Why
 *
 * Pre-fix the platform had no Stripe SDK at all. Once Phase 2 (W1.1)
 * adds the SDK, the temptation is to scatter `new Stripe(...)`
 * instantiations across handlers. That re-introduces the audit / breaker
 * / idempotency / per-tenant-key plumbing in every callsite — exactly
 * the duplication-and-drift class the canonical service exists to
 * prevent. The invariant fails any production code that imports
 * `stripe` outside `libs/backend-common/src/billing/` so the
 * architectural fence is enforced before merge.
 *
 * # What this test enforces
 *
 *   1. The canonical service files exist (foundation present).
 *   2. No production .ts file outside libs/backend-common/src/billing/
 *      imports `stripe` or types from `Stripe.*`.
 *   3. The canonical IStripeApiClient interface has the 7 methods
 *      production handlers depend on (createSubscription /
 *      updateSubscription / cancelSubscription / retrieveSubscription /
 *      createRefund / retrieveRefund / reportMeterEvent).
 *   4. ADR-016 exists at docs/adr/016-stripe-sdk-adoption.md.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ALLOWED_PATH_PREFIX = 'libs/backend-common/src/billing/';

describe('INVARIANT (BILLING-CRITICAL-001): StripeApiService is the only outbound Stripe surface', () => {
  it('the canonical service files exist', () => {
    const lsFiles = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files',
       'libs/backend-common/src/billing/*.ts'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(lsFiles).toContain('libs/backend-common/src/billing/stripe-api.service.ts');
    expect(lsFiles).toContain('libs/backend-common/src/billing/stripe-api.types.ts');
    expect(lsFiles).toContain('libs/backend-common/src/billing/stripe-api.module.ts');
    expect(lsFiles).toContain('libs/backend-common/src/billing/index.ts');
  });

  it('IStripeApiClient declares the required methods', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/billing/stripe-api.types.ts'),
      'utf8',
    );
    for (const method of [
      'createCustomer',
      'createSubscription',
      'updateSubscription',
      'cancelSubscription',
      'retrieveSubscription',
      'createRefund',
      'retrieveRefund',
      'finalizeInvoice',
      'reportMeterEvent',
    ]) {
      // The reportMeterEvent signature uses `args: StripeMeterEvent & { ... }`,
      // so accept either the inline-object shape OR an intersection.
      expect(src).toMatch(new RegExp(`\\b${method}\\(args:\\s*(?:\\{|StripeMeterEvent)`));
    }
  });

  it('the money callsites INJECT and CALL the canonical StripeApiService (not the dead service)', () => {
    // W1.1: before this PR the StripeApiService had zero consumers — the invariant
    // passed vacuously while subscriptions were a local-DB no-op. Pin each money
    // callsite to (a) import the canonical service and (b) actually call it on the
    // hot path, so a regression that drops the Stripe call fails CI.
    //
    // BILLING-CRITICAL-010 moved the subscription mint out of
    // create-subscription.handler.ts into StripeSubscriptionProvisionerService so
    // that the operator-provisioning path could share one copy of the idempotency
    // keys and the no-price rule. This list follows the calls to where they now
    // live; it is not relaxed to accommodate the move.
    const callsites: { file: string; methods: string[] }[] = [
      {
        file: 'apps/billing-service/src/billing/services/stripe-subscription-provisioner.service.ts',
        methods: ['createCustomer', 'createSubscription'],
      },
      {
        file: 'apps/billing-service/src/billing/handlers/cancel-subscription.handler.ts',
        methods: ['cancelSubscription'],
      },
      {
        file: 'apps/billing-service/src/billing/handlers/refund-payment.handler.ts',
        methods: ['createRefund'],
      },
      {
        file: 'apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts',
        methods: ['updateSubscription'],
      },
      {
        file: 'apps/billing-service/src/billing/handlers/finalize-invoice.handler.ts',
        methods: ['finalizeInvoice'],
      },
    ];
    for (const { file, methods } of callsites) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      expect(src).toMatch(
        /import\s*\{[^}]*\bStripeApiService\b[^}]*\}\s*from\s*['"]@aquaculture\/backend-common\/billing['"]/,
      );
      for (const method of methods) {
        expect(src).toMatch(new RegExp(`this\\.stripeApi\\.${method}\\(`));
      }
    }
  });

  it('BOTH subscription-creating paths reach Stripe through the shared provisioner', () => {
    // BILLING-CRITICAL-010: the GraphQL path minted the Stripe objects, but
    // operator provisioning raw-INSERTed into billing.subscriptions with
    // stripe_customer_id / stripe_subscription_id omitted from the column list
    // entirely. Those tenants had a subscription this platform believed in and
    // Stripe had never heard of — nothing charged them. The previous case above
    // could not catch that: it pinned one handler and said nothing about the
    // second writer, so half the platform's subscriptions were a local-DB no-op
    // while this invariant stayed green.
    //
    // Persistence of the returned ids is enforced separately by
    // tests/invariants/stripe-subscription-mint-single-source.spec.ts; this case
    // enforces that neither writer can stop calling Stripe at all.
    const PROVISIONER_IMPORT =
      /import\s*\{[^}]*\bStripeSubscriptionProvisionerService\b[^}]*\}\s*from\s*['"][^'"]*stripe-subscription-provisioner\.service['"]/;
    const subscriptionWriters = [
      'apps/billing-service/src/billing/handlers/create-subscription.handler.ts',
      'apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts',
    ];
    for (const file of subscriptionWriters) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      expect(src).toMatch(PROVISIONER_IMPORT);
      expect(src).toMatch(/\bensureStripeObjects\(/);
    }
  });

  it('ADR-016 documents the SDK adoption decision', () => {
    const adr = readFileSync(
      resolve(REPO_ROOT, 'docs/adr/016-stripe-sdk-adoption.md'),
      'utf8',
    );
    expect(adr).toMatch(/# ADR-016/);
    expect(adr).toMatch(/StripeApiService/);
    expect(adr).toMatch(/CircuitBreaker/);
    expect(adr).toMatch(/idempotency/i);
  });

  it('no production code outside libs/backend-common/src/billing/ imports the stripe SDK', () => {
    const lsFilesOut = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files',
        'apps/*.ts', 'apps/**/*.ts',
        'libs/*.ts', 'libs/**/*.ts',
        'platform/*.ts', 'platform/**/*.ts'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const files = lsFilesOut
      .split('\n')
      .filter(
        (f) =>
          f.length > 0 &&
          !f.includes('/__tests__/') &&
          !f.endsWith('.spec.ts') &&
          !f.endsWith('.test.ts') &&
          !f.startsWith(ALLOWED_PATH_PREFIX),
      );

    const offenders: { file: string; line: number; text: string }[] = [];
    const importRe = /\b(?:import|require)\s*\(?\s*['"](?:stripe|@stripe\/[^'"]+)['"]/;
    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/(?<!:)\/\/.*$/, ''));
      for (let i = 0; i < stripped.length; i += 1) {
        const line = stripped[i] ?? '';
        if (importRe.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} production import(s) of the stripe SDK outside the canonical billing/ directory.\n` +
          'All outbound Stripe traffic MUST flow through StripeApiService at\n' +
          'libs/backend-common/src/billing/stripe-api.service.ts (ADR-016).\n\n' +
          offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n'),
      );
    }
  });
});
