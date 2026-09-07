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
 *
 * ONE KNOWN EXCEPTION, and it is a finding rather than a carve-out. The plan
 * catalogue seed states its commitment discount as an INTEGER PERCENT inside a
 * per-cycle object -- `annual: { ..., discountPercent: 20 }` -- where the terms
 * module and the calculator state a fraction. A first version of this gate
 * matched only the fraction, so it claimed "exactly one place" while a second
 * table sat outside its sight, stating 10/15/20 against the 5/10/15 the
 * platform actually charges. The pattern below now matches BOTH spellings, and
 * `plan-definition.service.ts` is allowed by name and only until
 * BILLING-HIGH-009 (owner billing-expert, due 2026-10-05) settles whether
 * commitment terms are per-plan or platform-wide. A THIRD table fails here.
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
 * Sites carrying a second table under a tracked finding, allowed by name so a
 * new one still fails. Removing an entry is how the finding closes; adding one
 * needs a finding of its own.
 */
const TRACKED_SECOND_TABLES: Readonly<Record<string, string>> = {
  'apps/admin-api-service/src/billing/services/plan-definition.service.ts': 'BILLING-HIGH-009',
};

/**
 * A commitment-discount rate keyed on a cycle, in either spelling the codebase
 * uses.
 *
 * As a FRACTION in a rate map: `quarterly: 0.05`, `[BillingCycle.ANNUAL]: 0.15`.
 * Anchored on the non-zero rates, because a `monthly: 0` entry alone carries no
 * commercial claim and appears in unrelated zero-defaulted maps.
 */
const CYCLE_DISCOUNT_FRACTION =
  /(?:\[?\s*(?:BillingCycle\.)?(QUARTERLY|SEMI_ANNUAL|ANNUAL|quarterly|semi_annual|annual)\s*\]?)\s*:\s*0\.(?:0[1-9]|[1-9][0-9]?)\b/;

/**
 * As an INTEGER PERCENT inside a per-cycle pricing object:
 * `annual: { basePrice: 950, ..., discountPercent: 20 }`. Both the cycle key
 * and the field must appear on the same line, which is what keeps a custom
 * plan's own `discountPercent` -- a different concept, not keyed on a cycle --
 * out.
 */
const CYCLE_DISCOUNT_PERCENT =
  /\b(quarterly|semiAnnual|semi_annual|annual)\s*:\s*\{[^}]*\bdiscountPercent\s*:\s*[1-9][0-9]*/;

const CYCLE_DISCOUNT_RATE = new RegExp(
  `(?:${CYCLE_DISCOUNT_FRACTION.source})|(?:${CYCLE_DISCOUNT_PERCENT.source})`,
);

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

  it('declares the commitment discount in one place, plus only the tracked exception', () => {
    const offenders: string[] = [];

    for (const fileAbs of files) {
      const relPath = relative(REPO_ROOT, fileAbs);
      if (relPath === TERMS_DECLARATION) continue;
      if (relPath in TRACKED_SECOND_TABLES) continue;
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
          `@aquaculture/backend-common/billing. If a second table is unavoidable ` +
          `for now, it needs a registered finding and an entry in ` +
          `TRACKED_SECOND_TABLES:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('matches both spellings and leaves unrelated cycle code alone', () => {
    // Fraction form.
    expect(CYCLE_DISCOUNT_RATE.test('  [BillingCycle.ANNUAL]: 0.15, // 15% discount')).toBe(true);
    expect(CYCLE_DISCOUNT_RATE.test('  quarterly: 0.05,')).toBe(true);
    expect(CYCLE_DISCOUNT_RATE.test('  [BillingCycle.SEMI_ANNUAL]: 0.1,')).toBe(true);
    // Integer-percent form -- the spelling a first version of this gate missed
    // while claiming to cover every commitment discount.
    expect(
      CYCLE_DISCOUNT_RATE.test(
        '  annual: { basePrice: 950, perUserPrice: 96, discountPercent: 20 },',
      ),
    ).toBe(true);
    expect(CYCLE_DISCOUNT_RATE.test('  semiAnnual: { basePrice: 505, discountPercent: 15 },')).toBe(
      true,
    );
    // A months table is a different claim and is out of scope until
    // BILLING-HIGH-008 consolidates it.
    expect(CYCLE_DISCOUNT_RATE.test('  [BillingCycle.QUARTERLY]: 3,')).toBe(false);
    // A zero-defaulted map states no commercial term, in either spelling.
    expect(CYCLE_DISCOUNT_RATE.test('  [BillingCycle.MONTHLY]: 0,')).toBe(false);
    expect(CYCLE_DISCOUNT_RATE.test('  annual: { basePrice: 0, discountPercent: 0 },')).toBe(false);
    // An unrelated rate that is not keyed on a cycle.
    expect(CYCLE_DISCOUNT_RATE.test('  taxRate: 0.15,')).toBe(false);
    // A custom plan's own discount is a different concept and is not keyed on a
    // cycle, so it stays out.
    expect(CYCLE_DISCOUNT_RATE.test('  discountPercent: dto.discountPercent || 0,')).toBe(false);
  });

  it('still sees the tracked exception, rather than having stopped matching it', () => {
    // The allowlist must skip a REAL match. If plan-definition.service.ts ever
    // stopped matching, this gate would pass on a file it believes it is
    // holding, and BILLING-HIGH-009 would look closed without anyone closing it.
    for (const [relPath, findingId] of Object.entries(TRACKED_SECOND_TABLES)) {
      const matched = readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
        .split('\n')
        .some((line) => CYCLE_DISCOUNT_RATE.test(line));
      expect(`${relPath} (${findingId}) matches: ${matched}`).toBe(
        `${relPath} (${findingId}) matches: true`,
      );
    }
  });
});
