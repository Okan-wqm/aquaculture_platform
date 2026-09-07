/**
 * A billing cycle's commercial terms are declared once (BILLING-CRITICAL-007).
 *
 * What a longer cycle costs was written twice. `PricingCalculatorService`
 * (admin-api-service) multiplied the monthly total by the cycle's months and
 * took a commitment discount off — 5% quarterly, 10% semi-annual, 15% annual —
 * and that is the number an operator approves. `BillingSchedulerService`
 * (billing-service) multiplied by the months and took nothing off. So an annual
 * tenant was invoiced 15% above the price they signed, every year.
 *
 * Neither figure is implausible on its own and nobody reconciles a quote
 * against an invoice by hand, so nothing said so. The terms now live in
 * `libs/backend-common/src/billing/billing-cycle-terms.ts` and both sides call
 * `cycleAmountFor`.
 *
 * SCOPE. This bans a second COMMITMENT-DISCOUNT table, which is the thing that
 * disagreed. The months-per-cycle table is still duplicated across several
 * date-arithmetic paths (BILLING-HIGH-008, owner billing-expert, due
 * 2026-10-05); those copies have never disagreed with anything, and banning
 * them before they are consolidated would make this gate unlandable for a
 * reason it cannot defend.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Backend source trees that can price a subscription. */
const SCANNED_ROOTS = ['apps', 'libs', 'platform'] as const;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'build',
  '.nx',
  '__tests__',
  '.archive',
]);

/** The one file allowed to state the commercial terms. */
const TERMS_DECLARATION = 'libs/backend-common/src/billing/billing-cycle-terms.ts';

/**
 * A commitment-discount rate keyed on a cycle: `quarterly: 0.05`,
 * `[BillingCycle.ANNUAL]: 0.15`, `SEMI_ANNUAL: 0.1`. Anchored on the three
 * NON-ZERO rates, because a `monthly: 0` entry alone carries no commercial
 * claim and appears in unrelated zero-defaulted maps.
 */
const CYCLE_DISCOUNT_RATE =
  /(?:\[?\s*(?:BillingCycle\.)?(QUARTERLY|SEMI_ANNUAL|ANNUAL|quarterly|semi_annual|annual)\s*\]?)\s*:\s*0\.(?:05|1|10|15)\b/;

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

describe('INVARIANT: one set of billing-cycle commercial terms', () => {
  const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(resolve(REPO_ROOT, root)));

  it('scans the backend source it is meant to govern', () => {
    // A walker that matched nothing would make the case below vacuous.
    expect(files.length).toBeGreaterThan(1_000);
  });

  it('declares the commitment discount in exactly one place', () => {
    const offenders: string[] = [];

    for (const fileAbs of files) {
      const relPath = relative(REPO_ROOT, fileAbs);
      if (relPath === TERMS_DECLARATION) continue;
      readFileSync(fileAbs, 'utf-8')
        .split('\n')
        .forEach((line, index) => {
          if (CYCLE_DISCOUNT_RATE.test(line)) {
            offenders.push(`${relPath}:${index + 1}: ${line.trim()}`);
          }
        });
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} site(s) declare a billing-cycle commitment discount outside ` +
          `${TERMS_DECLARATION}. A second copy is how a quote and an invoice came to state ` +
          `different prices for the same subscription. Import ` +
          `BILLING_CYCLE_COMMITMENT_DISCOUNT — or better, cycleAmountFor — from ` +
          `@aquaculture/backend-common/billing:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('matches a rate table and leaves unrelated cycle code alone', () => {
    expect(CYCLE_DISCOUNT_RATE.test('  [BillingCycle.ANNUAL]: 0.15, // 15% discount')).toBe(true);
    expect(CYCLE_DISCOUNT_RATE.test('  quarterly: 0.05,')).toBe(true);
    expect(CYCLE_DISCOUNT_RATE.test('  [BillingCycle.SEMI_ANNUAL]: 0.1,')).toBe(true);
    // A months table is a different claim and is out of scope until
    // BILLING-HIGH-008 consolidates it.
    expect(CYCLE_DISCOUNT_RATE.test('  [BillingCycle.QUARTERLY]: 3,')).toBe(false);
    // A zero-defaulted map states no commercial term.
    expect(CYCLE_DISCOUNT_RATE.test('  [BillingCycle.MONTHLY]: 0,')).toBe(false);
    // An unrelated rate that is not keyed on a cycle.
    expect(CYCLE_DISCOUNT_RATE.test('  taxRate: 0.15,')).toBe(false);
  });
});
