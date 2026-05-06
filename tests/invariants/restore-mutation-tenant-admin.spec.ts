/**
 * restore-mutation-tenant-admin invariant — FARM-MEDIUM-002 follow-up
 * ============================================================================
 *
 * Every 'async restore<Entity>(...)' GraphQL mutation under the
 * `apps/farm-service/src` tree (any file matching '*.resolver.ts')
 * MUST be guarded by '@Roles(Role.TENANT_ADMIN)' — and ONLY
 * 'TENANT_ADMIN'. Restore is
 * privilege-elevated relative to create/update because:
 *
 *   - It re-activates a row that an operator (and possibly a
 *     compliance review) consciously soft-deleted. Letting MODULE_
 *     MANAGER reverse that decision unilaterally would defeat the
 *     soft-delete review trail.
 *   - It surfaces the row's contents to every downstream consumer
 *     that filters by 'isDeleted = false'. If the row carried PII
 *     or sensitive lifecycle state at deletion time, that exposure
 *     re-opens.
 *   - It triggers an audit_log RESTORE row. The audit trail's
 *     useful precondition is that "RESTORE was an admin decision";
 *     a wider permission would weaken that.
 *
 * The invariant scans every '*.resolver.ts' under the
 * `apps/farm-service/src` tree (recursively) for methods named
 * 'restore<Identifier>', and for each one asserts:
 *
 *   1. A '@Roles(...)' decorator is attached above the method (or
 *      its enclosing '@Mutation(...)' decorator block).
 *   2. The role list contains 'Role.TENANT_ADMIN'.
 *   3. The role list contains NO OTHER role identifiers.
 *
 * # When this spec fails
 *
 *   - A new 'restoreX' mutation lands without '@Roles(Role.TENANT_
 *     ADMIN)' → add it.
 *   - A 'restoreX' mutation gets '@Roles(Role.TENANT_ADMIN, Role.
 *     MODULE_MANAGER)' (e.g. copied from createX): narrow it.
 *   - A 'restoreX' mutation has @Roles with a different role: the
 *     permission matrix has shifted; either the matrix or this
 *     invariant needs to update — the failure forces the discussion.
 *
 * # What this invariant does NOT check
 *
 *   - Whether the resolver class is decorated with '@UseGuards(...)'
 *     — that's a separate concern owned by 'farm-service-tenant-
 *     isolation.spec.ts'.
 *   - Whether the entity actually has a 'restore()' method on its
 *     entity class. Adding a mutation against a non-restorable
 *     entity would fail at runtime when 'RestoreService.restore()'
 *     is called; type-checking catches this at PR time.
 *   - Methods named 'restoreX' that are NOT GraphQL mutations
 *     (private helpers, query handlers etc.). The regex requires
 *     'async restore' to be on the same logical block as a
 *     '@Mutation(' directly above it.
 *
 * Phase 4.2 of the "Farm modülü kalan kör noktalar" plan
 * (FARM-MEDIUM-002) shipped the first uniform restore-mutation
 * surface. This invariant freezes the @Roles posture so the next
 * addition cannot accidentally widen the permission.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FARM_SERVICE_SRC = path.resolve(REPO_ROOT, 'apps/farm-service/src');

interface RestoreMutationFinding {
  file: string;
  methodName: string;
  /** The decorator + signature block we extracted, useful for failure messages. */
  block: string;
  /** Roles array members extracted from '@Roles(...)', or null if no @Roles decorator. */
  roles: string[] | null;
}

/**
 * Recursively walk 'dir', calling 'visit' on every file path that
 * matches '*.resolver.ts'. Skips node_modules and __tests__ folders.
 */
function walkResolvers(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') {
        continue;
      }
      walkResolvers(full, visit);
      continue;
    }
    if (entry.endsWith('.resolver.ts')) {
      visit(full);
    }
  }
}

/**
 * Find every 'async restore<Identifier>(...)' method in the source
 * along with the @Roles decorator that immediately precedes it.
 *
 * The window we inspect is the 8 lines above each 'async restoreX('
 * — large enough to capture multi-line @Mutation + @Roles blocks
 * but tight enough to avoid catching the previous method's
 * decorators.
 */
function extractRestoreMutations(file: string): RestoreMutationFinding[] {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const findings: RestoreMutationFinding[] = [];

  const methodRegex = /^\s*async\s+(restore[A-Z][A-Za-z0-9]*)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(methodRegex);
    if (!m) continue;
    const methodName = m[1]!;
    const blockStart = Math.max(0, i - 8);
    const block = lines.slice(blockStart, i + 1).join('\n');

    // Look for '@Roles(...)' in the block. Captures the args list
    // verbatim so we can pull out role identifiers separately.
    const rolesMatch = block.match(/@Roles\s*\(([^)]+)\)/);
    const roles = rolesMatch
      ? rolesMatch[1]!
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : null;

    findings.push({ file, methodName, block, roles });
  }
  return findings;
}

describe('restore-mutation tenant-admin invariant (FARM-MEDIUM-002 follow-up)', () => {
  let findings: RestoreMutationFinding[];

  beforeAll(() => {
    findings = [];
    walkResolvers(FARM_SERVICE_SRC, (file) => {
      findings.push(...extractRestoreMutations(file));
    });
  });

  it('finds at least one restore mutation (sanity — confirms the scan works)', () => {
    // PR-47 ships restoreSite/Department/System/FeedingProgram on top
    // of the existing 5 (Feed, Chemical, Supplier, Species, Consumable).
    // Until PR-47 lands the floor is 5; once it lands the floor is 9.
    // Either way, > 0.
    expect(findings.length).toBeGreaterThan(0);
  });

  it('every restore<Entity> mutation carries an @Roles decorator', () => {
    const undecorated = findings
      .filter((f) => f.roles === null)
      .map((f) => '${path.relative(REPO_ROOT, f.file)} :: ${f.methodName}')
      .sort();
    expect(undecorated).toEqual([]);
  });

  it('every @Roles list on a restore mutation is exactly [Role.TENANT_ADMIN]', () => {
    const offenders = findings
      .filter((f) => f.roles !== null)
      .filter(
        (f) =>
          !(f.roles!.length === 1 && f.roles![0] === 'Role.TENANT_ADMIN'),
      )
      .map(
        (f) =>
          '${path.relative(REPO_ROOT, f.file)} :: ${f.methodName} → ' +
          '[${(f.roles ?? []).join(', ')}]',
      )
      .sort();
    expect(offenders).toEqual([]);
  });
});
