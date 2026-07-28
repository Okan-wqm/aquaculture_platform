/**
 * Platform-wide invariant — the two tier vocabularies have one author each, and
 * nothing re-declares either of them.
 *
 * # The two sets
 *
 * `TenantPlan` (`libs/event-contracts/src/enums/tenant-plan.enum.ts`) is the
 * ENTITLEMENT set — free/trial/starter/professional/enterprise. It is what
 * `auth.tenants.plan` stores, under a DB CHECK constraint, and what the admin
 * tenant DTOs validate with `@IsEnum(TenantPlan)`.
 *
 * `BillingPlanTier` (`libs/event-contracts/src/billing/billing-plan-tier.ts`) is
 * the SELLABLE set — free/starter/professional/enterprise/custom. It is what
 * `billing.subscriptions.plan_tier` stores. No `trial` (in billing that is a
 * subscription STATUS) and `custom` must never leak into `TenantPlan`.
 *
 * # What this used to enforce, and why that was wrong
 *
 * Before codegen, the admin panel could not import a backend library, so it kept
 * TWO hand-written literals — `PlanTier` in `services/types/billing.ts` and
 * `TenantTier` in `services/types/tenant.ts` — and this spec asserted both were
 * members-equal to `BillingPlanTier`.
 *
 * Pinning `TenantTier` to the SELLABLE set is what made the FE↔BE break
 * INVISIBLE. That type was handed to `POST/PATCH/GET /admin/tenants`, which
 * validate the ENTITLEMENT set. The panel's own types therefore said it could
 * send `custom` (the endpoint 400s it) and that `trial` was impossible (the
 * endpoint accepts it, and the column stores it). The gate was green throughout,
 * because it was comparing the copy to the wrong SSoT.
 *
 * # What this enforces now
 *
 *   1. Each SSoT still declares exactly its own set, and the two remain distinct
 *      (`trial` only in the entitlement one, `custom` only in the sellable one).
 *   2. No production file outside the allowlist declares a `PlanTier`,
 *      `TenantTier` or `TenantPlan` enum literal.
 *   3. The admin panel declares NEITHER by hand: both arrive through
 *      `tools/codegen/admin-contracts`, which reads the SSoT files directly, so
 *      there is no second copy left to hold in agreement. The generated values
 *      are checked against both SSoTs here — codegen staleness is caught by
 *      `admin-contracts-generated`, but a WRONG emission would not be, and this
 *      is the vocabulary where being wrong is expensive.
 *   4. The panel keeps the two apart: a tenant's plan is typed `TenantPlan`, and
 *      the surface that must satisfy both contracts at once uses the derived
 *      `ProvisionablePlan` intersection rather than picking one and casting.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const CANONICAL_BILLING_TIER = 'libs/event-contracts/src/billing/billing-plan-tier.ts';
const CANONICAL_TENANT_PLAN = 'libs/event-contracts/src/enums/tenant-plan.enum.ts';
const GENERATED_CONTRACTS = 'web/modules/admin-panel/src/services/types/generated/admin-contracts.ts';
const FE_BILLING = 'web/modules/admin-panel/src/services/types/billing.ts';
const FE_TENANT = 'web/modules/admin-panel/src/services/types/tenant.ts';
const FE_CONSTANTS = 'web/modules/admin-panel/src/constants/plan-tier.ts';
const GRAPHQL_CODEGEN = 'web/shared-ui/src/generated/graphql-types.ts';

/**
 * Files permitted to declare a tier symbol at all: the two canonical SSoT files
 * and the generated codegen artifacts. The frontend is NOT on this list any
 * more — that is the point of the fix.
 */
const ALLOWLIST = new Set<string>([
  CANONICAL_BILLING_TIER,
  CANONICAL_TENANT_PLAN,
  GRAPHQL_CODEGEN,
]);

function read(relFile: string): string {
  return readFileSync(resolve(REPO_ROOT, relFile), 'utf8');
}

/** Extract the string VALUES of an `export enum <Name> { NAME = 'value', ... }`. */
function enumValues(relFile: string, enumName: string): string[] {
  const src = read(relFile);
  const body = new RegExp(`export enum ${enumName}\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(src)?.[1];
  if (body == null) {
    throw new Error(`enum ${enumName} not found in ${relFile}`);
  }
  return Array.from(body.matchAll(/^\s*[A-Z0-9_]+\s*=\s*'([^']+)'/gm), (m) => m[1]!);
}

/**
 * Extract the string VALUES of a generated `export const <Name> = { NAME: "value", … } as const;`.
 *
 * The generator emits const objects rather than enums so `PlanTier.FREE` keeps
 * resolving at every existing call site while the type stays a union of the
 * serialized values.
 */
function generatedValues(name: string): string[] {
  const src = read(GENERATED_CONTRACTS);
  const body = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`, 'm').exec(src)?.[1];
  if (body == null) {
    throw new Error(`generated const ${name} not found in ${GENERATED_CONTRACTS}`);
  }
  return Array.from(body.matchAll(/^\s*[A-Z0-9_]+:\s*"([^"]+)"/gm), (m) => m[1]!);
}

describe('INVARIANT: the entitlement and sellable tier sets each have one author', () => {
  it('the canonical SSoTs declare their own sets and stay distinct', () => {
    const billing = new Set(enumValues(CANONICAL_BILLING_TIER, 'BillingPlanTier'));
    expect([...billing].sort()).toEqual(
      ['custom', 'enterprise', 'free', 'professional', 'starter'].sort(),
    );

    const tenantPlan = new Set(enumValues(CANONICAL_TENANT_PLAN, 'TenantPlan'));
    expect([...tenantPlan].sort()).toEqual(
      ['enterprise', 'free', 'professional', 'starter', 'trial'].sort(),
    );

    // The distinction IS the contract. If these ever converge, every call site
    // that relies on the compiler to keep them apart silently stops working.
    expect(tenantPlan.has('trial')).toBe(true);
    expect(billing.has('trial')).toBe(false);
    expect(billing.has('custom')).toBe(true);
    expect(tenantPlan.has('custom')).toBe(false);
  });

  it('no production file outside the allowlist declares a tier enum literal', () => {
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

    const literalRe = /^\s*export\s+enum\s+(?:PlanTier|TenantTier|TenantPlan)\b/m;
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
        `${offenders.length} file(s) declare a hand-copied tier enum.\n` +
          `Backend: re-export from @platform/event-contracts.\n` +
          `Admin panel: add the SSoT file to tools/codegen/admin-contracts/manifest.ts\n` +
          `and regenerate — a frontend literal is no longer allowed at all.\n\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }
  });

  it('the admin panel derives both vocabularies instead of declaring them', () => {
    for (const rel of [FE_BILLING, FE_TENANT]) {
      const src = read(rel);
      expect(src).not.toMatch(/export enum (?:PlanTier|TenantTier|TenantPlan)\s*\{/);
      expect(src).toContain('./generated/admin-contracts');
    }

    // The sellable set is re-exported through billing.ts; the entitlement set
    // through tenant.ts. Both by name, so the `export *` barrel is unambiguous.
    expect(read(FE_BILLING)).toMatch(/export\s*\{[\s\S]*?\bPlanTier\b[\s\S]*?\}/);
    expect(read(FE_TENANT)).toMatch(/export\s*\{\s*TenantPlan\s*\}/);
  });

  it('the generated vocabularies carry exactly the canonical values', () => {
    expect(generatedValues('PlanTier').sort()).toEqual(
      enumValues(CANONICAL_BILLING_TIER, 'BillingPlanTier').sort(),
    );
    expect(generatedValues('TenantPlan').sort()).toEqual(
      enumValues(CANONICAL_TENANT_PLAN, 'TenantPlan').sort(),
    );
  });

  it('a tenant-facing tier is the entitlement set, not the sellable one', () => {
    // The specific defect this replaces: the panel's tenant types carried the
    // SELLABLE vocabulary while every endpoint they reach validates the
    // ENTITLEMENT one.
    //
    // The READ shapes now come from the generated tenant DTOs, so that is where
    // the assertion belongs — `tier` on both must be the entitlement union
    // (which contains `trial` and no `custom`), never the sellable one.
    const generated = read(GENERATED_CONTRACTS);
    const entitlement = new Set(enumValues(CANONICAL_TENANT_PLAN, 'TenantPlan'));

    for (const shape of ['TenantSummaryDto', 'TenantListItemDto']) {
      const body = new RegExp(`export interface ${shape} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(
        generated,
      )?.[1];
      if (body == null) throw new Error(`generated interface ${shape} not found`);

      const tier = /^\s*tier:\s*(.+);$/m.exec(body)?.[1];
      if (tier == null) throw new Error(`${shape} has no tier field`);

      const members = new Set(Array.from(tier.matchAll(/"([^"]+)"/g), (m) => m[1]!));
      expect({ shape, members: [...members].sort() }).toEqual({
        shape,
        members: [...entitlement].sort(),
      });
    }

    // The WRITE contracts the panel still declares by hand must agree.
    const tenantTypes = read(FE_TENANT);
    expect(tenantTypes).toMatch(/\btier\?:\s*TenantPlan;/);
    expect(tenantTypes).not.toMatch(/\btier\??:\s*PlanTier;/);
  });

  it('the surface that must satisfy both contracts derives the overlap', () => {
    // The create-tenant wizard's tier field feeds BOTH `POST /admin/tenants`
    // (entitlement) and the quote request (sellable). Picking either one and
    // casting at the other call site is how the page carried a page-local tier
    // literal for so long. The overlap is an intersection of the two generated
    // unions, so it cannot fall behind either SSoT.
    const constants = read(FE_CONSTANTS);
    expect(constants).toMatch(/export type ProvisionablePlan = TenantPlan & PlanTier;/);
    expect(constants).toMatch(/export const PROVISIONABLE_PLANS/);
  });
});
