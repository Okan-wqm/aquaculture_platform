/**
 * createTenantQueryKey must NOT be used inside invalidateQueries / removeQueries.
 *
 * createTenantQueryKey appends a `{__sessionEpoch}` segment (the #687 cache-generation
 * token). Used as an invalidation PREFIX, that epoch segment lands at the same index
 * as a LIST query's filter, so the prefix no longer matches the query and the
 * invalidation silently hits NOTHING — create/update/delete stop refreshing their
 * lists. Invalidation MUST use `createTenantInvalidationKey` (the epoch-less prefix).
 * The contract is pinned in
 * web/shared-ui/src/utils/tenant-invalidation-key.contract.spec.ts.
 *
 * RATCHET: this caps the count of the broken pattern (a #687 regression). It may only
 * SHRINK as call sites migrate to createTenantInvalidationKey; a NEW one fails CI.
 * Burndown tracked: docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-252. Tier-3.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['web/modules', 'web/shell/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', '__mocks__']);
// An invalidate/remove call whose key is built with createTenantQueryKey, up to the
// statement terminator. [^;] crosses newlines, so multi-line calls match too.
const PATTERN = /(?:invalidateQueries|removeQueries)\([^;]*createTenantQueryKey\(/g;

/**
 * High-water mark of broken createTenantQueryKey-based invalidations. RATCHET: only
 * ever DECREASE this, in lockstep with migrating call sites to
 * createTenantInvalidationKey. 2026-06-29: a #687 regression. useEdgeDevices fixed in
 * #722 (→44); the sensor cluster (AutomationProgramEditorPage/usePlcControl/
 * useAlertRules/AutomationProgramsPage/useLoRaDevices) fixed here (→6). The last 6
 * (hr useLeaves/useCertifications, tenant-admin TenantDashboard/useTenantData, shell
 * MainLayout) burn down next.
 */
const BASELINE_CEILING = 6;

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

describe('no createTenantQueryKey inside invalidate/remove (epoch-safe)', () => {
  it('the broken-invalidation pattern may only shrink (use createTenantInvalidationKey)', () => {
    expect(count).toBeLessThanOrEqual(BASELINE_CEILING);
  });
});
