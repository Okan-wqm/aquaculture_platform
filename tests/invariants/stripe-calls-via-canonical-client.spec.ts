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

  it('the money handlers INJECT and CALL the canonical StripeApiService (not the dead service)', () => {
    // W1.1: before this PR the StripeApiService had zero consumers — the invariant
    // passed vacuously while subscriptions were a local-DB no-op. Pin each money
    // handler to (a) import the canonical service and (b) actually call it on the
    // hot path, so a regression that drops the Stripe call fails CI.
    const handlers: { file: string; method: string }[] = [
      {
        // ADR-0014: the subscription create+customer calls moved out of the
        // handler into SubscriptionWriterService, so admin tenant provisioning
        // — which minted no Stripe objects at all — reaches the same code.
        // The handler now goes through the writer; the writer holds the calls.
        file: 'apps/billing-service/src/billing/services/subscription-writer.service.ts',
        method: 'createSubscription',
      },
      {
        file: 'apps/billing-service/src/billing/services/subscription-writer.service.ts',
        method: 'createCustomer',
      },
      {
        // The reactivation and trial-extension handlers ADR-0014 added, which
        // replaced raw UPDATEs that told Stripe nothing at all.
        file: 'apps/billing-service/src/billing/handlers/reactivate-subscription.handler.ts',
        method: 'updateSubscription',
      },
      {
        file: 'apps/billing-service/src/billing/handlers/extend-subscription-trial.handler.ts',
        method: 'updateSubscription',
      },
      {
        file: 'apps/billing-service/src/billing/handlers/cancel-subscription.handler.ts',
        method: 'cancelSubscription',
      },
      {
        file: 'apps/billing-service/src/billing/handlers/refund-payment.handler.ts',
        method: 'createRefund',
      },
      {
        file: 'apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts',
        method: 'updateSubscription',
      },
      {
        file: 'apps/billing-service/src/billing/handlers/finalize-invoice.handler.ts',
        method: 'finalizeInvoice',
      },
    ];
    for (const { file, method } of handlers) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      expect(src).toMatch(
        /import\s*\{[^}]*\bStripeApiService\b[^}]*\}\s*from\s*['"]@aquaculture\/backend-common\/billing['"]/,
      );
      expect(src).toMatch(new RegExp(`this\\.stripeApi\\.${method}\\(`));
    }
  });

  it('both subscription-creating paths reach Stripe through the shared writer (ADR-0014)', () => {
    // admin tenant provisioning used to raw-INSERT the subscription row with
    // stripe_customer_id and stripe_subscription_id left NULL, so an
    // operator-provisioned tenant had a subscription Stripe never knew about.
    for (const file of [
      'apps/billing-service/src/billing/handlers/create-subscription.handler.ts',
      'apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts',
    ]) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      expect(src).toMatch(/subscriptionWriter\.ensureStripeObjects\(/);
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
