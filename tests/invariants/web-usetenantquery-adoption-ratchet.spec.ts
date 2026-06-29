/**
 * useTenantQuery adoption ratchet (plan A2 / E-series).
 *
 * Tenant data hooks should use `useTenantQuery` / `useTenantMutation` — the SSoT that
 * bakes in the tenant-scoped key + the auth enabled-gate + keepPreviousData — NOT
 * hand-roll `useQuery` + `createTenantQueryKey`. Hand-rolling is where the
 * cross-tenant-leak / missing-tenant-fetch / blank-on-error bugs hide.
 *
 * This ratchet caps the number of raw `createTenantQueryKey(` usages in the FE
 * modules/shell. It may only SHRINK as hooks migrate to the SSoT:
 *   - a NEW raw usage pushes the count over the ceiling → CI fails (new tenant hooks
 *     must use useTenantQuery/useTenantMutation, or createTenantInvalidationKey for
 *     invalidation);
 *   - migrating hooks lowers the count; lower BASELINE_CEILING in lockstep (a
 *     review-visible ratchet edit).
 *
 * Incremental migration of the existing usages is tracked under
 * docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-216. Tier-3 "make it detectable".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['web/modules', 'web/shell/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', '__mocks__']);
const PATTERN = /createTenantQueryKey\(/g;

/**
 * High-water mark of raw createTenantQueryKey usages in FE modules/shell. RATCHET:
 * only ever DECREASE this, in lockstep with migrating hooks to useTenantQuery.
 * 2026-06-29: 282 → 258 (useEdgeDevices' 24 invalidation keys moved to
 * createTenantInvalidationKey, see web-no-createtenantquerykey-in-invalidate).
 */
const BASELINE_CEILING = 258;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(spec|test)\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const count = SCAN_ROOTS.flatMap((r) => walk(resolve(REPO_ROOT, r))).reduce((n, f) => {
  const m = readFileSync(f, 'utf8').match(PATTERN);
  return n + (m ? m.length : 0);
}, 0);

describe('useTenantQuery adoption ratchet', () => {
  it('raw createTenantQueryKey usage in FE modules/shell may only shrink', () => {
    expect(count).toBeLessThanOrEqual(BASELINE_CEILING);
  });
});
