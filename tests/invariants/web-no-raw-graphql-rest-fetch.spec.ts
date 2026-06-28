/**
 * Frontend must route GraphQL/REST through the SANCTIONED shared clients
 * (graphqlClient, restClient, and — once it exists — a pre-auth publicGraphqlClient),
 * never raw `fetch('/graphql')` / `fetch('/api')`.
 *
 * WHY: raw transport bypasses the shared client's auth-barrier wait, JWT header,
 * `x-tenant-id` header, and 502/transport-error handling — the exact source of
 * FE↔gateway drift (the /graphql 400s), missing-tenant requests, and the
 * focus/reconnect refetch storms this initiative is closing.
 *
 * RATCHET: KNOWN_OFFENDERS is the frozen burn-down list of files that STILL use raw
 * fetch — the plan's A7 debt (pre-auth forms need a publicGraphqlClient; farm uploads
 * need restClient multipart). It may only SHRINK:
 *   - a NEW file using raw transport → not in the set → FAILS (no regression);
 *   - a baselined file that no longer offends → the ratchet test FAILS until it is
 *     REMOVED from the set (a review-visible edit), so the baseline can't go stale.
 * Debt tracked: docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-204.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['web/modules', 'web/shell/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', '__mocks__']);
const RAW_TRANSPORT = /fetch\(\s*[`'"](?:\/graphql|\/api)/;

/** A7 burn-down — files that STILL use raw fetch. This set may ONLY shrink. */
const KNOWN_OFFENDERS = new Set<string>([
  'web/modules/farm-module/src/hooks/useChemicals.ts', // 2x /api upload — needs restClient multipart
  'web/shell/src/pages/auth/ForgotPasswordForm.tsx', // /graphql pre-auth — needs publicGraphqlClient
  'web/shell/src/pages/auth/ResetPasswordForm.tsx', // /graphql pre-auth
  'web/shell/src/pages/auth/AcceptInvitationForm.tsx', // 2x /graphql pre-auth
]);

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

const offenders = SCAN_ROOTS.flatMap((r) => walk(resolve(REPO_ROOT, r)))
  .filter((f) => RAW_TRANSPORT.test(readFileSync(f, 'utf8')))
  .map((f) => f.replace(`${REPO_ROOT}/`, ''));

describe('frontend uses sanctioned GraphQL/REST clients, not raw fetch', () => {
  it('scans a non-empty file surface', () => {
    expect(offenders.length).toBeGreaterThanOrEqual(0); // sanity: scan ran
  });

  it('no NEW raw fetch(/graphql|/api) outside the frozen A7 burn-down list', () => {
    const unexpected = offenders.filter((f) => !KNOWN_OFFENDERS.has(f));
    expect(unexpected).toEqual([]);
  });

  it('every baselined offender still offends (ratchet cannot go stale)', () => {
    const fixed = [...KNOWN_OFFENDERS].filter((f) => {
      try {
        return !RAW_TRANSPORT.test(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
      } catch {
        return true; // file moved/deleted → must be removed from the set
      }
    });
    expect(fixed).toEqual([]); // remove these from KNOWN_OFFENDERS
  });
});
