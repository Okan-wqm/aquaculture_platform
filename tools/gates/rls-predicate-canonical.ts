/**
 * TENANT-ISOLATION-CRITICAL-001 — the canonical RLS predicate authority.
 *
 * **Every `CREATE POLICY` in a migration that names a tenant-isolation policy
 * MUST use the canonical RLS predicate from
 * `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`.**
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
 *   - missing `, true` second argument to `current_setting()` — raises an
 *     exception on unset GUC instead of returning empty string.
 *
 * A typo in the RLS predicate silently allows cross-tenant data exposure. The
 * helper exists precisely so no migration hand-rolls its own SQL; migrations
 * that call `applyTenantRlsToSchema(...)` are canonical by construction.
 *
 * ONE OWNER, TWO READERS (ARIA-HIGH-011): the invariant
 * `tests/invariants/rls-predicate-canonical.spec.ts` fails the build on a
 * violation, and ARIA's `sql-migration-safety-adapter` observes the same
 * verdict. Both import this module — the predicate check, the policy-name
 * scope and the grandfather list exist once.
 */

/** The rule id this authority reports under (the adapter's finding rule). */
export const RLS_PREDICATE_NOT_CANONICAL_RULE = 'rls-predicate-not-canonical';

/**
 * Migrations that pre-date the helper. After the day-one baseline reset
 * (Faz 6) only baseline migrations exist and all use the helper; the list is
 * intentionally minimal — only migrations that pre-date the helper (the
 * `1776000000000` farm RLS rollout and the `1781000000000` refresh) are exempt.
 */
export const RLS_PREDICATE_GRANDFATHERED: ReadonlySet<string> = new Set([
  // Pre-helper RLS rollout — predates applyTenantRlsToSchema helper.
  'apps/farm-service/src/database/migrations/1776000000000-EnableRowLevelSecurity.ts',
  // Refresh of the same predicate during the helper migration window.
  'apps/farm-service/src/database/migrations/1781000000000-RefreshTenantRlsPredicate.ts',
  // Messaging cohort RLS enablement (predates helper consolidation).
  'apps/messaging-service/src/migrations/1782400000000-EnableRowLevelSecurity.ts',
]);

/**
 * The migrations this rule governs: TypeScript sources under a service's
 * `src/migrations/` or `src/database/migrations/` tree, at any depth, that are
 * not tests. Workspace-relative POSIX paths. The leading `apps/<…>/` segment
 * spans `/` the way the `git ls-files 'apps/*\/src/migrations/*.ts'` pathspec
 * the invariant used to carry does (a pathspec `*` crosses directories).
 */
export function isRlsPredicateScopedPath(relPath: string): boolean {
  return (
    /^apps\/.+?\/src\/(?:database\/)?migrations\/.+\.ts$/.test(relPath) &&
    !relPath.includes('__tests__') &&
    !relPath.endsWith('.spec.ts') &&
    !relPath.endsWith('.test.ts')
  );
}

const HELPER_CALL_RE = /applyTenantRlsToSchema\s*\(/;

// Match a CREATE POLICY block — captures policy name + the USING clause.
// Tolerates whitespace, quoted identifiers, multi-line statements.
const CREATE_POLICY_RE =
  /CREATE\s+POLICY\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s+ON\s+[\w."]+\s+(?:FOR\s+\w+\s+)?(?:TO\s+[\w,\s"]+\s+)?USING\s*\(([\s\S]*?)\)\s*(?:WITH\s+CHECK|;)/gi;

const TENANT_ISOLATION_POLICY_NAMES = ['tenant_isolation_policy', 'tenant_isolation'];

/** One tenant-isolation policy whose USING clause is not canonical. */
export interface NonCanonicalTenantPolicy {
  readonly policy: string;
  readonly reason: string;
  readonly excerpt: string;
  /** 1-based line of the `CREATE POLICY` in the source. */
  readonly line: number;
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
export function validateUsingClause(usingClause: string): string | null {
  const c = usingClause.toLowerCase();

  if (!c.includes("current_setting('app.bypass_rls'")) {
    return 'missing app.bypass_rls clause (admin/background-job bypass)';
  }
  if (!c.includes("current_setting('app.current_tenant'")) {
    return 'missing app.current_tenant clause (tenant context comparison)';
  }
  if (!c.includes('nullif(')) {
    return 'missing NULLIF() wrapper — raw COALESCE/cast crashes on unset GUC (the 2026-Q1 farm-service bug)';
  }
  if (!c.includes('::uuid')) {
    return 'missing ::uuid cast on RHS — tenant_id is a uuid column';
  }
  if (!c.includes(', true)')) {
    return 'missing `, true` second arg to current_setting() — raises exception on unset GUC';
  }
  return null;
}

/**
 * Every inline tenant-isolation `CREATE POLICY` in `source` whose USING clause
 * is not canonical. A migration that calls `applyTenantRlsToSchema(...)` is
 * canonical by construction and yields nothing; so does a migration with no
 * `CREATE POLICY` and no `tenant_isolation_policy` mention. Grandfathering is
 * by path and is the caller's question (`RLS_PREDICATE_GRANDFATHERED`).
 */
export function findNonCanonicalTenantPolicies(
  source: string,
): readonly NonCanonicalTenantPolicy[] {
  // Helper-based migrations are inherently canonical; skip.
  if (HELPER_CALL_RE.test(source)) return [];

  // Quick scope check.
  if (!/CREATE\s+POLICY/i.test(source) && !source.includes('tenant_isolation_policy')) {
    return [];
  }

  const violations: NonCanonicalTenantPolicy[] = [];
  for (const match of source.matchAll(CREATE_POLICY_RE)) {
    const policyName = match[1];
    const usingClause = match[2];
    // ORPHAN-HIGH-507 — both captures guarded before use. A CREATE POLICY
    // the regex matched but whose name or USING clause did not bind is a
    // statement this rule cannot judge, so it is skipped rather than
    // asserted non-null: an assertion would crash the RLS invariant on a
    // malformed migration, which is the one case it most needs to survive
    // in order to report the others.
    if (policyName === undefined || usingClause === undefined) continue;

    // Only tenant_isolation policies are subject to this rule.
    // Non-tenant policies (e.g. role-based access) are not governed by this rule.
    const isTenantPolicy = TENANT_ISOLATION_POLICY_NAMES.some((n) =>
      policyName.toLowerCase().includes(n),
    );
    if (!isTenantPolicy) continue;

    const reason = validateUsingClause(usingClause);
    if (reason) {
      violations.push({
        policy: policyName,
        reason,
        excerpt: usingClause.trim().slice(0, 200),
        line: source.slice(0, match.index).split('\n').length,
      });
    }
  }
  return violations;
}
