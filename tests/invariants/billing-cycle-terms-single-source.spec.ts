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
 * SCOPE. Both tables, now. The gate first banned only a second
 * COMMITMENT-DISCOUNT table, because that was the one that had disagreed, and
 * banning the months table before it was consolidated would have made the gate
 * unlandable for a reason it could not defend. `module-quote.ts` then turned
 * out to hold a second copy of BOTH (BILLING-HIGH-008 for the months,
 * BILLING-HIGH-009 for the discount), with `module-pricing.service.ts` reading
 * that copy rather than the terms module — so the quote engine and the invoice
 * scheduler were once again pricing from two independent declarations of the
 * same commercial rule. They agreed on every value, which is precisely why
 * nothing said so. Both are consolidated, so both are now gated.
 *
 * THE SPELLINGS THAT HID, and they are the point. `module-quote.ts` wrote its
 * rates QUOTED -- `quarterly: '0.05'` -- and the first pattern required an
 * unquoted decimal. Four more copies of the months table were written as
 * SWITCHES -- `case BillingCycle.QUARTERLY: return 3` -- which no per-line,
 * object-shaped pattern can see at all. So this gate reported a single source
 * while five duplicates sat inside the tree it was scanning. Both spellings are
 * matched now, and the cases below pin them: a gate that can only see one
 * spelling of a duplicate is a gate that certifies its own blind spot.
 *
 * A duplicate in any spelling fails here.
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
// Empty, and that is the ratchet working. The one tracked exception was
// `apps/admin-api-service/src/billing/services/plan-definition.service.ts`,
// which held a second 10/15/20 commitment-discount table against the
// calculator's 5/10/15 (BILLING-HIGH-009). ADR-0013 moved the plan catalogue
// into billing and deleted `PricingCalculatorService` with it, so neither table
// is in admin-api any more and the file no longer matches. An entry that stops
// matching would make this gate pass on a file it believes it is holding, so it
// is removed rather than kept as decoration.
const TRACKED_SECOND_TABLES: Readonly<Record<string, string>> = {};

/**
 * An object key naming a billing cycle, in every spelling the codebase writes
 * one: bare (`annual:`), quoted (`'annual':`), or computed
 * (`[BillingCycle.ANNUAL]:`).
 *
 * The lookbehind is load-bearing: without it the pattern would find `annual`
 * inside `semiannualRate` or `perAnnual`, and a gate that fires on a word it
 * found in the middle of another word gets allowlisted into uselessness.
 */
function cycleKey(...spellings: string[]): string {
  return String.raw`(?<![\w$])\[?\s*(?:BillingCycle\.)?['"]?(?:${spellings.join('|')})['"]?\s*\]?`;
}

const ANY_CYCLE_KEY = cycleKey(
  'QUARTERLY',
  'SEMI_ANNUAL',
  'ANNUAL',
  'quarterly',
  'semi_annual',
  'semiAnnual',
  'annual',
);

/**
 * A commitment-discount rate keyed on a cycle, as a FRACTION in a rate map:
 * `quarterly: 0.05`, `[BillingCycle.ANNUAL]: 0.15`, `annual: '0.15'`.
 *
 * The QUOTED form is the one that hid: `module-quote.ts` wrote `'0.05'` and the
 * first version of this pattern required an unquoted decimal, so a full second
 * table sat inside the scanned tree while the gate reported a single source.
 *
 * Anchored on the non-zero rates, because a `monthly: 0` entry alone carries no
 * commercial claim and appears in unrelated zero-defaulted maps.
 */
const CYCLE_DISCOUNT_FRACTION = new RegExp(
  String.raw`(?:${ANY_CYCLE_KEY})\s*:\s*['"]?0\.(?:0[1-9]|[1-9][0-9]?)\b`,
);

/**
 * The months-per-cycle table: `quarterly: 3`, `[BillingCycle.ANNUAL]: 12`.
 *
 * Anchored on a cycle key paired with THAT cycle's own month count, so an
 * unrelated `annual: 3` (a retention window, a chart bucket) does not match and
 * only a real restatement of the table does. `monthly: 1` is deliberately not
 * matched: one month is the trivial case and states nothing on its own.
 */
const CYCLE_MONTHS = new RegExp(
  [
    String.raw`(?:${cycleKey('QUARTERLY', 'quarterly')})\s*:\s*['"]?3\b`,
    String.raw`(?:${cycleKey('SEMI_ANNUAL', 'semi_annual', 'semiAnnual')})\s*:\s*['"]?6\b`,
    String.raw`(?:${cycleKey('ANNUAL', 'annual')})\s*:\s*['"]?12\b`,
  ].join('|'),
);

/**
 * As an INTEGER PERCENT inside a per-cycle pricing object:
 * `annual: { basePrice: 950, ..., discountPercent: 20 }`. Both the cycle key
 * and the field must appear on the same line, which is what keeps a custom
 * plan's own `discountPercent` -- a different concept, not keyed on a cycle --
 * out.
 */
const CYCLE_DISCOUNT_PERCENT =
  /\b(quarterly|semiAnnual|semi_annual|annual)\s*:\s*\{[^}]*\bdiscountPercent\s*:\s*[1-9][0-9]*/;

/**
 * The months table written as a SWITCH rather than an object — the spelling
 * that carried four of the five duplicates and that a per-line, object-shaped
 * pattern cannot see:
 *
 * ```text
 * case BillingCycle.QUARTERLY:
 *   return 3;
 * ```
 *
 * Matched as "a case labelled with a cycle, followed inside the same statement
 * by that cycle's own month count". That one shape covers every form the
 * duplicates actually took — `return 3`, `return basePrice / 3`, and
 * `end.setMonth(end.getMonth() + 3)` — without enumerating them, which is what
 * a pattern built from the three known spellings would have done, and it would
 * then have missed the fourth.
 *
 * `[^;{}]` bounds the match to a single statement so a case cannot reach into
 * the one below it for its number.
 */
function cycleMonthsCase(spellings: string[], months: number): string {
  return String.raw`case\s+(?:BillingCycle\.)?['"]?(?:${spellings.join('|')})['"]?\s*:[^;{}]{0,120}?\b${months}\b`;
}

const CYCLE_MONTHS_SWITCH = new RegExp(
  [
    cycleMonthsCase(['QUARTERLY', 'quarterly'], 3),
    cycleMonthsCase(['SEMI_ANNUAL', 'semi_annual', 'semiAnnual'], 6),
    cycleMonthsCase(['ANNUAL', 'annual'], 12),
  ].join('|'),
);

/**
 * Any restatement of a billing cycle's commercial terms, in any spelling. One
 * pattern rather than several gates: a duplicate of the months table and a
 * duplicate of the discount table are the same defect — a second declaration of
 * a rule the platform is only allowed to state once — and they arrived
 * together, in the same file, both times.
 */
const CYCLE_TERMS_RESTATEMENT = new RegExp(
  [CYCLE_DISCOUNT_FRACTION, CYCLE_DISCOUNT_PERCENT, CYCLE_MONTHS, CYCLE_MONTHS_SWITCH]
    .map((pattern) => `(?:${pattern.source})`)
    .join('|'),
  'g',
);

/**
 * Blanks out comments, preserving newlines so line numbers survive.
 *
 * A duplicate written in prose is not a duplicate, and treating it as one is
 * how a gate earns an allowlist entry it should never have needed: the
 * `metered-billing.service.ts` cycle switch — which maps a cycle to an
 * AGGREGATION PERIOD and is not a months table at all — carries the comment
 * "combine all 6 months in the range query" directly under its `SEMI_ANNUAL`
 * case, and would otherwise be reported as a second months table on the
 * strength of a sentence.
 */
function withoutComments(source: string): string {
  const blankOut = (match: string): string => match.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blankOut).replace(/\/\/[^\n]*/g, blankOut);
}

/** Any file that could possibly hold a duplicate names a cycle somewhere. */
const CYCLE_WORD = /quarterly|annual/i;

/** 1-based line number of a character offset. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Asks the pattern a clean question.
 *
 * `CYCLE_TERMS_RESTATEMENT` carries the `g` flag so the scan can report every
 * duplicate in a file rather than only the first. A `g` regex remembers
 * `lastIndex` between `.test()` calls, so consecutive assertions against it
 * would answer about different offsets of different strings — the case below
 * would pass or fail depending on the order its lines are written in.
 */
function restates(text: string): boolean {
  CYCLE_TERMS_RESTATEMENT.lastIndex = 0;
  return CYCLE_TERMS_RESTATEMENT.test(text);
}

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

  it('states the commercial terms of a cycle in one place, plus only tracked exceptions', () => {
    const offenders: string[] = [];

    for (const fileAbs of files) {
      const relPath = relative(REPO_ROOT, fileAbs);
      if (relPath === TERMS_DECLARATION) continue;
      if (relPath in TRACKED_SECOND_TABLES) continue;
      const source = readFileSync(fileAbs, 'utf-8');
      // Cheap literal pre-filter. Every spelling the patterns match names a
      // cycle, so a file with no cycle word in it cannot hold a duplicate — and
      // that is nearly every file in three source trees. Without this, the
      // switch pattern's bounded `[^;{}]` window backtracks across ~3,800 files
      // and the gate takes twenty seconds in a lane named `invariants-fast`.
      if (!CYCLE_WORD.test(source)) continue;
      const scanned = withoutComments(source);
      for (const match of scanned.matchAll(CYCLE_TERMS_RESTATEMENT)) {
        const line = lineOf(scanned, match.index);
        // Report from the ORIGINAL source, so the message shows the code as
        // written rather than with its comments blanked.
        offenders.push(`${relPath}:${line}: ${(source.split('\n')[line - 1] ?? '').trim()}`);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} site(s) restate a billing-cycle commercial term outside ` +
          `${TERMS_DECLARATION}. A second copy is how a quote and an invoice came to state ` +
          `different prices for the same subscription — and the copies agreeing today is not ` +
          `protection, it is just the failure not having happened yet. Import ` +
          `BILLING_CYCLE_MONTHS, commitmentDiscountRateFor — or better, cycleAmountFor — from ` +
          `@aquaculture/backend-common/billing. A second table that genuinely cannot be ` +
          `avoided needs a registered finding with an owner and a deadline, and an entry in ` +
          `TRACKED_SECOND_TABLES:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('matches every spelling of a restatement and leaves unrelated cycle code alone', () => {
    // Discount, fraction form.
    expect(restates('  [BillingCycle.ANNUAL]: 0.15, // 15% discount')).toBe(true);
    expect(restates('  quarterly: 0.05,')).toBe(true);
    expect(restates('  [BillingCycle.SEMI_ANNUAL]: 0.1,')).toBe(true);
    // Discount, QUOTED fraction -- module-quote.ts wrote its second table this
    // way and the first pattern required an unquoted decimal, so the duplicate
    // sat in the scanned tree while this gate reported a single source.
    expect(restates("  quarterly: '0.05',")).toBe(true);
    expect(restates("  annual: '0.15',")).toBe(true);
    // Discount, integer-percent form -- the spelling a first version of this
    // gate missed while claiming to cover every commitment discount.
    expect(restates('  annual: { basePrice: 950, perUserPrice: 96, discountPercent: 20 },')).toBe(
      true,
    );
    expect(restates('  semiAnnual: { basePrice: 505, discountPercent: 15 },')).toBe(true);
    // Months. In scope since BILLING-HIGH-008 consolidated the second copy.
    expect(restates('  [BillingCycle.QUARTERLY]: 3,')).toBe(true);
    expect(restates('  semi_annual: 6,')).toBe(true);
    expect(restates('  annual: 12,')).toBe(true);
    // A zero-defaulted map states no commercial term, in any spelling.
    expect(restates('  [BillingCycle.MONTHLY]: 0,')).toBe(false);
    expect(restates('  annual: { basePrice: 0, discountPercent: 0 },')).toBe(false);
    // Neither does `monthly: 1` -- one month is the trivial case.
    expect(restates('  monthly: 1,')).toBe(false);
    // A cycle key paired with a month count that is not ITS month count is some
    // other quantity: a retention window, a chart bucket, a page size.
    expect(restates('  annual: 3,')).toBe(false);
    expect(restates('  quarterly: 12,')).toBe(false);
    // An unrelated rate that is not keyed on a cycle.
    expect(restates('  taxRate: 0.15,')).toBe(false);
    // A custom plan's own discount is a different concept and is not keyed on a
    // cycle, so it stays out.
    expect(restates('  discountPercent: dto.discountPercent || 0,')).toBe(false);
    // A cycle word found INSIDE another identifier is not a cycle key.
    expect(restates('  semiannualReviewMonths: 6,')).toBe(false);
    expect(restates('  perAnnual: 0.15,')).toBe(false);
  });

  it('still sees the tracked exception, rather than having stopped matching it', () => {
    // The allowlist must skip a REAL match. If plan-definition.service.ts ever
    // stopped matching, this gate would pass on a file it believes it is
    // holding, and BILLING-HIGH-009 would look closed without anyone closing it.
    for (const [relPath, findingId] of Object.entries(TRACKED_SECOND_TABLES)) {
      const matched = readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
        .split('\n')
        .some((line) => restates(line));
      expect(`${relPath} (${findingId}) matches: ${matched}`).toBe(
        `${relPath} (${findingId}) matches: true`,
      );
    }
  });
});
