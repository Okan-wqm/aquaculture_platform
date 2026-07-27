/**
 * APA-147 — admin-api must have exactly ONE pricing source.
 *
 * Three byte-identical `{ TRIAL: 0, STARTER: 99, PROFESSIONAL: 299,
 * ENTERPRISE: 499 }` tables were copy-pasted into `ReportsService`, driving the
 * `mrr` / `lifetimeValue` / `revenue` columns of the tenant-overview, churn and
 * revenue reports — while the dashboard's MRR came from the real SSoT
 * (`billing.subscriptions.pricing.basePrice`, normalised by billing cycle).
 *
 * An in-code tier table cannot see a repricing, a negotiated custom plan, a $0
 * tier, or any billing cycle but monthly. So the reports and the dashboard
 * disagreed about the same tenants on the same screen, BY CONSTRUCTION — not
 * because someone forgot to update one, but because two sources of a single
 * fact can only agree by coincidence.
 *
 * The cure is `monthlyPriceOf()` in
 * `analytics/entities/external/subscription-pricing.util.ts`: one function,
 * taking a billing read-model row, so a hardcoded price has nowhere to be read
 * from. This gate stops the table growing back.
 *
 * WHAT IT CATCHES: an object literal mapping a plan/tier name to a NON-ZERO
 * number literal, anywhere under `analytics/`. That is the shape of a price
 * table. Zero-valued accumulators (`{ starter: 0, professional: 0 }`, used to
 * total revenue BY plan) are excluded — a table whose every entry is zero is a
 * counter seed, not a pricing source.
 *
 * # WHY THE SCOPE IS `analytics/` AND NOT ALL OF admin-api
 *
 * `billing/data/default-module-pricing.ts` also holds plan-keyed numbers
 * (`DEFAULT_TIER_MULTIPLIERS`, 1.0 / 0.9 / 0.7). Those are NOT the same thing
 * and banning them would be wrong: they are the write-side seed of a DB
 * catalogue, consumed exclusively by `ModulePricingService.seedDefaultPricing()`
 * to INSERT `module_pricing` rows, after which every read goes to the database.
 * Authoring a default catalogue has to start somewhere in code.
 *
 * The defect APA-147 describes is different in kind: a table read at REPORT
 * time, standing in for the billing SSoT. That only happens in read paths that
 * produce money-bearing output — which in this service is `analytics/`. The
 * second assertion below keeps the two apart by pinning the seed catalogue to
 * the seeder, so it cannot quietly become a read-time source later.
 *
 * Tier-3 make-detectable, backing the tier-1 single-function cure.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-147
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Read paths that produce money-bearing output. See the scope note above. */
const TRACKED_GLOB = 'apps/admin-api-service/src/analytics/**/*.ts';

const EXEMPT_PATH_PATTERNS = [
  /\/migrations\//,
  /__tests__\//,
  /__mocks__\//,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.d\.ts$/,
] as const;

/**
 * `[SomePlan.STARTER]: 99` or `starter: 99` / `'starter': 99` — a plan-ish key
 * bound to a NON-ZERO number literal. The non-zero requirement is what
 * separates a price table from a per-plan accumulator seeded at zero.
 */
const PLAN_NAMES = '(?:trial|free|starter|basic|professional|pro|business|enterprise|custom|premium)';
const PRICE_ENTRY_RE = new RegExp(
  `(?:\\[\\s*[A-Za-z_$][\\w$]*\\.(?:${PLAN_NAMES})\\s*\\]|['"\`]?${PLAN_NAMES}['"\`]?)\\s*:\\s*(\\d+(?:\\.\\d+)?)`,
  'i',
);

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function listTrackedFiles(): readonly string[] {
  const out = execSync(`git ls-files -z -- '${TRACKED_GLOB}'`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => existsSync(resolve(REPO_ROOT, p)))
    .filter((p) => !EXEMPT_PATH_PATTERNS.some((rx) => rx.test(p)));
}

/** Strip comments while preserving line count, so prose cannot trip the gate. */
function stripCommentsPreservingLines(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function scanFile(file: string): readonly Hit[] {
  const raw = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
  const codeLines = stripCommentsPreservingLines(raw).split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  const hits: Hit[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    const match = PRICE_ENTRY_RE.exec(codeLines[i] ?? '');
    if (!match) continue;
    // A zero is an accumulator seed, not a price.
    if (Number(match[1]) === 0) continue;
    hits.push({ file, line: i + 1, text: (rawLines[i] ?? '').trim() });
  }
  return hits;
}

describe('INVARIANT: admin-api has one pricing source (APA-147)', () => {
  const hits = listTrackedFiles().flatMap((f) => [...scanFile(f)]);

  it('no hardcoded plan-price table exists in admin-api-service', () => {
    if (hits.length > 0) {
      const lines = hits.map((h) => `  ${h.file}:${h.line}: ${h.text.slice(0, 110)}`).join('\n');
      throw new Error(
        `${hits.length} hardcoded plan price(s) found in admin-api analytics:\n${lines}\n\n` +
          `An in-code tier table is a SECOND pricing source. It cannot see a ` +
          `repricing, a negotiated custom plan, a $0 tier, or any billing cycle ` +
          `but monthly, so it and the billing SSoT can only agree by ` +
          `coincidence — which is how every report's MRR came to contradict the ` +
          `dashboard's MRR on the same screen (APA-147).\n\n` +
          `Fix: read \`billing.subscriptions\` and price it with ` +
          `\`monthlyPriceOf()\` from ` +
          `\`analytics/entities/external/subscription-pricing.util.ts\`.`,
      );
    }
    expect(hits).toEqual([]);
  });

  it('the billing seed catalogue stays write-side — only the seeder may read it', () => {
    // If this list ever grows a read path, the seed defaults have become a
    // second read-time pricing source and the scope note above stops holding.
    const importers = execSync(
      "git grep -l \"from '../data/default-module-pricing'\" -- 'apps/admin-api-service/src/**/*.ts' || true",
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((p) => !EXEMPT_PATH_PATTERNS.some((rx) => rx.test(p)));

    expect(importers).toEqual(['apps/admin-api-service/src/billing/services/module-pricing.service.ts']);
  });

  it('the one sanctioned pricing function still exists and is exhaustive', () => {
    const util = readFileSync(
      resolve(
        REPO_ROOT,
        'apps/admin-api-service/src/analytics/entities/external/subscription-pricing.util.ts',
      ),
      'utf-8',
    );
    expect(util).toMatch(/export function monthlyPriceOf\(/);
    // The `never` binding is what makes a new BillingCycle a compile error here
    // instead of a silently mispriced report.
    expect(util).toMatch(/const unreachable: never = subscription\.billingCycle/);
  });
});
