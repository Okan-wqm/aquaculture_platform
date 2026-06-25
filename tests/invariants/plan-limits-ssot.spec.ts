/**
 * Platform-wide invariant — SSOT-C-13:
 *
 * Per-plan resource limits live in EXACTLY ONE place — the canonical
 * `PLAN_CATALOG` at `libs/event-contracts/src/billing/plan-catalog.ts`. Every
 * consumer (gateway middleware + interceptor, tenant-lookup, auth provisioning,
 * billing seed + subscription handler, admin plan-definition) PROJECTS its
 * local shape from that catalog; none re-declares the numbers.
 *
 * # Why
 *
 * Pre-fix the limit numbers were hand-copied across FIVE per-plan catalogs that
 * had already drifted (a STARTER tenant was 20 sensors here, 50 sensors there;
 * 5 users here, 10 there). Whichever service a request hit decided the limit,
 * so the platform had no single truth about what a customer bought. Collapsing
 * them to a constant is necessary but not sufficient — without a guard, the
 * sixth copy reappears the next time someone needs a default in a new service.
 *
 * # What this test enforces
 *
 *   1. The SSoT file exists and exports PLAN_CATALOG + resolvePlanLimits.
 *   2. PLAN_CATALOG has an entry for every TenantPlan enum member (a per-tier
 *      drift in the SSoT itself would be a compile error, but we assert it
 *      statically too so the catalog can never silently lose a tier).
 *   3. No OTHER production file declares a per-plan limits MAP. The signal for
 *      such a map — the precise drift class — is: a hard-coded numeric limit
 *      (maxSensors/maxPonds/maxFarms/maxUsers : <number>) co-located with two
 *      or more plan-tier tokens (starter/professional/enterprise) in the same
 *      file. A single degenerate default (one fallback object, not keyed by
 *      plan) does not match and is intentionally allowed.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SSOT_REL = 'libs/event-contracts/src/billing/plan-catalog.ts';

describe('INVARIANT (SSOT-C-13): PLAN_CATALOG is the only per-plan limits catalog', () => {
  it('the SSoT file exists and exports the catalog + resolver', () => {
    const src = readFileSync(resolve(REPO_ROOT, SSOT_REL), 'utf8');
    expect(src).toMatch(/export const PLAN_CATALOG\s*:/);
    expect(src).toMatch(/export function resolvePlanLimits\s*\(/);
  });

  it('PLAN_CATALOG covers every TenantPlan member', () => {
    const enumSrc = readFileSync(
      resolve(REPO_ROOT, 'libs/event-contracts/src/enums/tenant-plan.enum.ts'),
      'utf8',
    );
    // Extract enum member names from `enum TenantPlan { FREE = 'free', ... }`.
    const enumBody = enumSrc.match(/export enum TenantPlan\s*\{([^}]*)\}/)?.[1];
    if (!enumBody) {
      throw new Error('TenantPlan enum body not found in tenant-plan.enum.ts');
    }
    const members = Array.from(
      enumBody.matchAll(/\b([A-Z_]+)\s*=/g),
      (m) => m[1],
    ).filter((name): name is string => Boolean(name));
    expect(members.length).toBeGreaterThanOrEqual(5);

    const catalogSrc = readFileSync(resolve(REPO_ROOT, SSOT_REL), 'utf8');
    for (const member of members) {
      expect(catalogSrc).toContain(`[TenantPlan.${member}]`);
    }
  });

  it('no other production file declares a per-plan limits map', () => {
    const lsOut = execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'ls-files',
        'apps/*.ts',
        'apps/**/*.ts',
        'libs/*.ts',
        'libs/**/*.ts',
        'platform/*.ts',
        'platform/**/*.ts',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );

    const files = lsOut
      .split('\n')
      .filter(
        (f) =>
          f.length > 0 &&
          !f.includes('/__tests__/') &&
          !f.endsWith('.spec.ts') &&
          !f.endsWith('.test.ts') &&
          f !== SSOT_REL,
      );

    const numericLimitRe = /\bmax(?:Sensors|Ponds|Farms|Users)\s*:\s*-?\d+/;
    const tierTokenRe = /\b(?:starter|professional|enterprise)\b/gi;

    const offenders: string[] = [];
    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      if (!numericLimitRe.test(src)) continue;
      const tierHits = new Set(
        (src.match(tierTokenRe) ?? []).map((t) => t.toLowerCase()),
      );
      // A genuine per-plan catalog names two or more distinct tiers alongside
      // hard-coded limit numbers. One degenerate fallback object does not.
      if (tierHits.size >= 2) {
        offenders.push(rel);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} file(s) declare a hand-copied per-plan limits map.\n` +
          `Per-plan limit numbers MUST live only in ${SSOT_REL} (PLAN_CATALOG, SSOT-C-13).\n` +
          `Project your local shape from resolvePlanLimits() instead.\n\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }
  });
});
