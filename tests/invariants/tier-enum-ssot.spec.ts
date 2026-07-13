/**
 * Platform-wide invariant — Billing Revival Faz D (D8):
 *
 * The billing/admin sellable-tier enum lives in EXACTLY ONE place — the
 * canonical `BillingPlanTier` at
 * `libs/event-contracts/src/billing/billing-plan-tier.ts`. Every backend copy
 * re-exports it; the two admin-panel frontend copies (which cannot import an
 * `@platform/*` backend library) keep a literal enum PINNED member-for-member
 * to that SSoT.
 *
 * # Why
 *
 * Pre-fix, `PlanTier` (and the admin-panel's matching `TenantTier`) was
 * re-declared by hand in five places that had already drifted — the analytics
 * read-model even dropped `FREE`, so a FREE subscription row could not map back
 * to a tier. A single canonical enum + re-export collapses the backend copies;
 * this guard makes the sixth copy detectable so the drift surface cannot grow
 * back (tier-3 make-it-detectable). The shared members are additionally locked
 * to the entitlement `TenantPlan` by compile-time guards inside the SSoT file
 * (tier-1), which `tsc --noEmit` enforces.
 *
 * # What this test enforces
 *
 *   1. The canonical SSoT declares `BillingPlanTier` with exactly the sellable
 *      set {free, starter, professional, enterprise, custom}, and `TenantPlan`
 *      still carries the entitlement set (incl. trial).
 *   2. No production file OUTSIDE the allowlist declares an `export enum PlanTier`
 *      or `export enum TenantTier` literal (a re-exported alias is allowed; a
 *      fresh literal is the drift class this catches).
 *   3. The two allowlisted frontend literals are members-equal to the canonical
 *      `BillingPlanTier` value set (FE/BE parity).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const CANONICAL_BILLING_TIER = 'libs/event-contracts/src/billing/billing-plan-tier.ts';
const CANONICAL_TENANT_PLAN = 'libs/event-contracts/src/enums/tenant-plan.enum.ts';
const FE_BILLING = 'web/modules/admin-panel/src/services/types/billing.ts';
const FE_TENANT = 'web/modules/admin-panel/src/services/types/tenant.ts';
const CODEGEN = 'web/shared-ui/src/generated/graphql-types.ts';

/**
 * Files permitted to declare a `PlanTier`/`TenantTier` symbol at all: the two
 * canonical SSoT files, the generated GraphQL types (codegen artifact), and the
 * two frontend literals that cannot import the backend SSoT (pinned by part 3).
 */
const ALLOWLIST = new Set<string>([
  CANONICAL_BILLING_TIER,
  CANONICAL_TENANT_PLAN,
  CODEGEN,
  FE_BILLING,
  FE_TENANT,
]);

/** Extract the string VALUES of an `export enum <Name> { NAME = 'value', ... }`. */
function enumValues(relFile: string, enumName: string): string[] {
  const src = readFileSync(resolve(REPO_ROOT, relFile), 'utf8');
  const body = new RegExp(`export enum ${enumName}\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(src)?.[1];
  if (body == null) {
    throw new Error(`enum ${enumName} not found in ${relFile}`);
  }
  return Array.from(body.matchAll(/^\s*[A-Z0-9_]+\s*=\s*'([^']+)'/gm), (m) => m[1]!);
}

describe('INVARIANT (Faz D / D8): BillingPlanTier is the only tier-enum SSoT', () => {
  it('the canonical SSoT declares the sellable and entitlement tier sets', () => {
    const billing = new Set(enumValues(CANONICAL_BILLING_TIER, 'BillingPlanTier'));
    expect([...billing].sort()).toEqual(
      ['custom', 'enterprise', 'free', 'professional', 'starter'].sort(),
    );

    // TenantPlan is the DISTINCT entitlement enum: it carries `trial` and has no
    // `custom`. Assert it still does so the two enums never silently converge.
    const tenantPlan = new Set(enumValues(CANONICAL_TENANT_PLAN, 'TenantPlan'));
    expect(tenantPlan.has('trial')).toBe(true);
    expect(tenantPlan.has('custom')).toBe(false);
  });

  it('no production file outside the allowlist declares a PlanTier/TenantTier enum literal', () => {
    const lsOut = execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'ls-files',
        'apps/**/*.ts',
        'libs/**/*.ts',
        'platform/**/*.ts',
        'web/**/*.ts',
        'web/**/*.tsx',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );

    const literalRe = /^\s*export\s+enum\s+(?:PlanTier|TenantTier)\b/m;
    const offenders: string[] = [];
    for (const rel of lsOut.split('\n')) {
      if (
        rel.length === 0 ||
        rel.endsWith('.spec.ts') ||
        rel.endsWith('.test.ts') ||
        rel.includes('/__tests__/') ||
        ALLOWLIST.has(rel)
      ) {
        continue;
      }
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      if (literalRe.test(src)) {
        offenders.push(rel);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} file(s) declare a hand-copied PlanTier/TenantTier enum.\n` +
          `Re-export BillingPlanTier from @platform/event-contracts instead (Faz D, D8).\n` +
          `A frontend literal that cannot import the backend SSoT must be added to\n` +
          `the allowlist AND pinned by the FE-parity assertion in this spec.\n\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }
  });

  it('the allowlisted frontend literals are members-equal to the canonical set', () => {
    const canonical = new Set(enumValues(CANONICAL_BILLING_TIER, 'BillingPlanTier'));

    for (const [rel, name] of [
      [FE_BILLING, 'PlanTier'],
      [FE_TENANT, 'TenantTier'],
    ] as const) {
      const feValues = new Set(enumValues(rel, name));
      expect({ file: rel, values: [...feValues].sort() }).toEqual({
        file: rel,
        values: [...canonical].sort(),
      });
    }
  });
});
