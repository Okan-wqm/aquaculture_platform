/**
 * Platform-wide invariant — DATA-MEDIUM-009 / ADR-0004 (billing surface):
 *
 * Billing money crosses the GraphQL wire as an exact-decimal STRING (the
 * `Decimal` scalar), NOT as a lossy IEEE-754 `Float`. During the additive
 * coexistence window each deprecated `Float` money field keeps a parallel
 * `*Decimal` sibling, populated by a `@ResolveField` in
 * `billing-decimal.resolver.ts`.
 *
 * # Why this lives in tests/invariants/
 *
 * Two silent regressions this guards:
 *   1. A new billing money field ships as `Float`-only — a future
 *      high-volume invoice then rounds on the wire (the exact failure mode
 *      PLAT-LOW-001 / PLAT-LOW-002 describe).
 *   2. The tenant-admin billing UI keeps reading the deprecated `Float`
 *      field, so when the `Float` is finally removed at the end of
 *      coexistence the page silently breaks.
 *
 * # What this spec asserts
 *
 *   A. Every schema-reachable billing money @ObjectType has a `*Decimal`
 *      field resolver registered in `BillingDecimalResolvers`.
 *   B. The two tenant-admin billing GraphQL operations select the `*Decimal`
 *      sibling for every deprecated money field they select.
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-MEDIUM-009
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

const RESOLVERS_PATH = 'apps/billing-service/src/billing/billing-decimal.resolver.ts';
const FE_OPS_PATH = 'web/modules/tenant-admin/src/graphql/billing-queries.ts';

/** Schema-reachable billing money @ObjectType → the `*Decimal` fields it must expose. */
const REACHABLE_MONEY_TYPES: Record<string, string[]> = {
  Invoice: [
    'subtotalDecimal',
    'discountDecimal',
    'totalDecimal',
    'amountPaidDecimal',
    'amountDueDecimal',
  ],
  InvoiceLineItem: ['unitPriceDecimal', 'amountDecimal'],
  TaxInfo: ['taxAmountDecimal'],
  Payment: ['amountDecimal', 'refundedAmountDecimal'],
  RefundInfo: ['amountDecimal'],
  Plan: ['basePriceDecimal'],
  PlanPricing: [
    'basePriceDecimal',
    'perFarmPriceDecimal',
    'perSensorPriceDecimal',
    'perUserPriceDecimal',
  ],
  TenantSubscriptionDto: ['monthlyPriceDecimal'],
  TenantInvoiceDto: ['amountDecimal'],
};

describe('DATA-MEDIUM-009 — billing money Decimal-scalar coexistence', () => {
  const resolvers = read(RESOLVERS_PATH);

  describe('A. every reachable money type has its `*Decimal` field resolvers', () => {
    for (const [type, fields] of Object.entries(REACHABLE_MONEY_TYPES)) {
      it(`${type} has a @Resolver with all its *Decimal ResolveFields`, () => {
        expect(resolvers).toContain(`@Resolver(() => ${type})`);
        for (const field of fields) {
          // The field name appears as a @ResolveField method name.
          expect(resolvers).toMatch(new RegExp(`\\b${field}\\s*\\(`));
        }
      });
    }

    it('every declared resolver class is registered in BillingDecimalResolvers', () => {
      const classNames = [...resolvers.matchAll(/export class (\w+DecimalResolver)/g)].map(
        (m) => m[1],
      );
      expect(classNames.length).toBeGreaterThan(0);
      const arrayBlock = resolvers.slice(resolvers.indexOf('BillingDecimalResolvers'));
      for (const name of classNames) {
        expect(arrayBlock).toContain(name);
      }
    });
  });

  describe('B. tenant-admin billing operations select the `*Decimal` siblings', () => {
    const feOps = read(FE_OPS_PATH);

    // (deprecated Float field selected by an FE op) → (its required *Decimal sibling)
    const REQUIRED_FE_SIBLINGS: Array<[deprecated: string, decimal: string]> = [
      ['monthlyPrice', 'monthlyPriceDecimal'],
      ['amount', 'amountDecimal'],
      ['basePrice', 'basePriceDecimal'],
    ];

    for (const [deprecated, decimalField] of REQUIRED_FE_SIBLINGS) {
      it(`selects ${decimalField} wherever ${deprecated} is read`, () => {
        // The word-boundary match avoids matching the sibling itself.
        expect(feOps).toMatch(new RegExp(`\\b${decimalField}\\b`));
      });
    }
  });
});
