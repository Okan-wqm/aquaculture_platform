/**
 * Platform-wide invariant — TENANT-ISOLATION-CRITICAL-001:
 *
 * **Every `CREATE POLICY` in a migration that names a tenant-isolation
 * policy MUST use the canonical RLS predicate from
 * `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`.**
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

const REPO_ROOT = resolve(__dirname, '..', '..');

const GRANDFATHERED: ReadonlySet<string> = new Set([
  // Pre-helper RLS rollout — predates applyTenantRlsToSchema helper.
  'apps/farm-service/src/database/migrations/1776000000000-EnableRowLevelSecurity.ts',
  // Refresh of the same predicate during the helper migration window.
  'apps/farm-service/src/database/migrations/1781000000000-RefreshTenantRlsPredicate.ts',
  // Messaging cohort RLS enablement (predates helper consolidation).
  'apps/messaging-service/src/migrations/1782400000000-EnableRowLevelSecurity.ts',
]);

const HELPER_CALL_RE = /applyTenantRlsToSchema\s*\(/;

// Match a CREATE POLICY block — captures policy name + the USING clause.
// Tolerates whitespace, quoted identifiers, multi-line statements.
const CREATE_POLICY_RE =
  /CREATE\s+POLICY\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s+ON\s+[\w."]+\s+(?:FOR\s+\w+\s+)?(?:TO\s+[\w,\s"]+\s+)?USING\s*\(([\s\S]*?)\)\s*(?:WITH\s+CHECK|;)/gi;

const TENANT_ISOLATION_POLICY_NAMES = [
  'tenant_isolation_policy',
  'tenant_isolation',
];

interface Violation {
  file: string;
  policy: string;
  reason: string;
  excerpt: string;
}

function listMigrationFiles(): string[] {
  let out: string;
  try {
    out = execSync(
      `git -C ${REPO_ROOT} ls-files 'apps/*/src/migrations/*.ts' 'apps/*/src/migrations/**/*.ts' 'apps/*/src/database/migrations/*.ts' 'apps/*/src/database/migrations/**/*.ts'`,
      { encoding: 'utf8' },
    );
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((p) => !p.includes('__tests__'))
    .filter((p) => !p.endsWith('.spec.ts'))
    .filter((p) => !p.endsWith('.test.ts'));
}

/**
 * The canonical USING clause requires three structural elements present
 * within the same parenthesised block:
 *
 *   1. `current_setting('app.bypass_rls'` reference
 *   2. `NULLIF(current_setting('app.current_tenant'` reference
 *   3. `::uuid` cast on the right-hand side
 *
 * We check by substring (case-insensitive) so cosmetic whitespace, line
 * breaks, or alternative quoting do not produce false positives.
 */
function validateUsingClause(usingClause: string): string | null {
  const c = usingClause.toLowerCase();

  if (!c.includes("current_setting('app.bypass_rls'")) {
    return "missing app.bypass_rls clause (admin/background-job bypass)";
  }
  if (!c.includes("current_setting('app.current_tenant'")) {
    return "missing app.current_tenant clause (tenant context comparison)";
  }
  if (!c.includes('nullif(')) {
    return "missing NULLIF() wrapper — raw COALESCE/cast crashes on unset GUC (the 2026-Q1 farm-service bug)";
  }
  if (!c.includes('::uuid')) {
    return "missing ::uuid cast on RHS — tenant_id is a uuid column";
  }
  if (!c.includes(', true)')) {
    return "missing `, true` second arg to current_setting() — raises exception on unset GUC";
  }
  return null;
}

describe('INVARIANT — RLS predicate canonical (TENANT-ISOLATION-CRITICAL-001)', () => {
  const files = listMigrationFiles();

  it('repository contains migration files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every inline CREATE POLICY for tenant_isolation_policy uses the canonical predicate', () => {
    const violations: Violation[] = [];

    for (const relativePath of files) {
      if (GRANDFATHERED.has(relativePath)) continue;

      const fullPath = resolve(REPO_ROOT, relativePath);
      const src = readFileSync(fullPath, 'utf8');

      // Helper-based migrations are inherently canonical; skip.
      if (HELPER_CALL_RE.test(src)) continue;

      // Quick scope check.
      if (!/CREATE\s+POLICY/i.test(src) && !src.includes('tenant_isolation_policy')) {
        continue;
      }

      CREATE_POLICY_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CREATE_POLICY_RE.exec(src)) !== null) {
        const policyName = match[1];
        const usingClause = match[2];
        if (!policyName || !usingClause) continue;

        // Only tenant_isolation policies are subject to this invariant.
        // Non-tenant policies (e.g. role-based access) are out of scope.
        const isTenantPolicy = TENANT_ISOLATION_POLICY_NAMES.some((n) =>
          policyName.toLowerCase().includes(n),
        );
        if (!isTenantPolicy) continue;

        const reason = validateUsingClause(usingClause);
        if (reason) {
          violations.push({
            file: relativePath,
            policy: policyName,
            reason,
            excerpt: usingClause.trim().slice(0, 200),
          });
        }
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
