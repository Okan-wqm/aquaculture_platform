/**
 * Platform-wide invariant — TENANT-ISOLATION-CRITICAL-001:
 *
 * **Every `CREATE POLICY` in a migration that names a tenant-isolation
 * policy MUST use the canonical RLS predicate from
 * `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`.**
 *
 * The rule — predicate check, tenant-policy scope and grandfather list — lives
 * in ONE owner, `tools/gates/rls-predicate-canonical.ts`: this spec fails the
 * build on it and ARIA's `sql-migration-safety-adapter` observes the same
 * verdict (ARIA-HIGH-011).
 *
 * # CANONICAL PREDICATE
 *
 * Per `apply-tenant-rls.helper.ts:222-237`:
 *
 * ```sql
 * USING (
 *   current_setting('app.bypass_rls', true) = 'on'
 *   OR
 *   "<tenant_col>" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
 * )
 * ```
 *
 * Variations that violate the canonical form:
 *
 *   - `COALESCE(current_setting('app.current_tenant', true), '')::uuid`
 *     — throws on unset GUC; the previous farm-service bug.
 *   - missing `NULLIF` — same crash class.
 *   - missing `app.bypass_rls` clause — admin/background jobs cannot read.
 *   - hardcoded tenant column name (`tenant_id` vs `"tenantId"`) — case
 *     sensitivity differs between snake_case farm-service and camelCase
 *     auth-service schemas.
 *   - missing `, true` second argument to `current_setting()` — raises an
 *     exception on unset GUC instead of returning empty string.
 *
 * # WHY THE INVARIANT
 *
 * A typo in the RLS predicate silently allows cross-tenant data exposure.
 * The helper exists precisely so no migration hand-rolls its own SQL — but
 * historically some migrations did write inline policies. This invariant
 * catches future drift.
 *
 * # SCOPE
 *
 * Migration files under `apps/*\/src/migrations/**` and
 * `apps/*\/src/database/migrations/**`.
 *
 * A migration is considered "RLS-related" if its body contains:
 *   - `CREATE POLICY`, OR
 *   - the literal substring `tenant_isolation_policy`.
 *
 * Migrations that simply call `applyTenantRlsToSchema(...)` (helper-based)
 * pass automatically — the helper produces the canonical SQL by construction.
 *
 * # GRANDFATHERED HISTORICAL MIGRATIONS
 *
 * After the day-one baseline reset (Faz 6), only baseline migrations exist
 * and all use the helper. The grandfather list is intentionally minimal —
 * only migrations that pre-date the helper (`1776000000000` farm RLS rollout
 * and the `1781000000000` refresh) are exempted.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  RLS_PREDICATE_GRANDFATHERED,
  findNonCanonicalTenantPolicies,
  isRlsPredicateScopedPath,
} from '../../tools/gates/rls-predicate-canonical';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface Violation {
  file: string;
  policy: string;
  reason: string;
  excerpt: string;
}

function listMigrationFiles(): string[] {
  // The scope (which migrations this rule governs) is the owner's predicate,
  // so this spec and ARIA's adapter cannot disagree on which files count.
  return execSync(`git -C ${REPO_ROOT} ls-files -- apps`, { encoding: 'utf8' })
    .split('\n')
    .filter(isRlsPredicateScopedPath);
}

describe('INVARIANT — RLS predicate canonical (TENANT-ISOLATION-CRITICAL-001)', () => {
  const files = listMigrationFiles();

  it('repository contains migration files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every inline CREATE POLICY for tenant_isolation_policy uses the canonical predicate', () => {
    const violations: Violation[] = [];

    for (const relativePath of files) {
      if (RLS_PREDICATE_GRANDFATHERED.has(relativePath)) continue;

      const src = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
      for (const violation of findNonCanonicalTenantPolicies(src)) {
        violations.push({
          file: relativePath,
          policy: violation.policy,
          reason: violation.reason,
          excerpt: violation.excerpt,
        });
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map(
          (v) =>
            `  - ${v.file}\n      policy: ${v.policy}\n      reason: ${v.reason}\n      USING:  ${v.excerpt}`,
        )
        .join('\n');
      throw new Error(
        `RLS predicate canonical invariant violated:\n${detail}\n\n` +
          `Resolution:\n` +
          `  1. PREFERRED: replace the inline CREATE POLICY with a call to\n` +
          `       applyTenantRlsToSchema(queryRunner, {...})\n` +
          `     from libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts.\n` +
          `  2. If hand-rolling is unavoidable, use the canonical USING:\n` +
          `       current_setting('app.bypass_rls', true) = 'on'\n` +
          `       OR\n` +
          `       "<tenant_col>" = NULLIF(current_setting('app.current_tenant', true), '')::uuid\n`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
