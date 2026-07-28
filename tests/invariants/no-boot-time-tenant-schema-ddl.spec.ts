/**
 * Platform-wide invariant — DATA-CRITICAL-002 / LEGAL-HIGH-004:
 *
 * `TenantSchemaSyncService` MUST be a read-only drift detector — it must
 * NEVER issue DDL (CREATE TABLE, ALTER TABLE, DROP TABLE, etc.) from
 * `OnApplicationBootstrap`. Schema mutations belong in the migration
 * ledger (per-tenant fan-out migration in the owning service), gated
 * by the canonical legal-hold registry.
 *
 * # Why
 *
 * The pre-2026-04-28 implementation ran `CREATE TABLE ... LIKE source`
 * and `ALTER TABLE ... ADD COLUMN ...` to silently fix tenant-schema
 * drift at boot. Two compounding architectural defects:
 *
 *   1. ADR-011 + ADR-012 violation — DDL applied OUTSIDE the migration
 *      ledger. No version row, no rollback, invisible in `git log` and
 *      `pg_migrations`. Same shape as the `synchronize: true` antipattern.
 *      (DATA-CRITICAL-002.)
 *   2. Legal-hold registry bypass — every destructive or schema-changing
 *      operation against a tenant schema MUST consult the canonical hold
 *      registry. Boot-time DDL bypassed it entirely; held tenants got
 *      DDL applied silently. (LEGAL-HIGH-004.)
 *
 * Removing the DDL-applying code paths is the make-impossible cure for
 * both findings — legal hold cannot be bypassed by a code path that
 * does not exist.
 *
 * # What this invariant checks
 *
 * Source-text grep over `tenant-schema-sync.service.ts`. Forbidden
 * substrings: any of the DDL keywords that would represent a schema
 * mutation. Allowed: SELECT-only diagnostics, structured logging,
 * fail-loud throws.
 *
 * # Allowed shape
 *
 *   - The class implements OnApplicationBootstrap and runs detection
 *     only.
 *   - The detect path uses SELECT against information_schema /
 *     pg_attribute. No DDL at all.
 *
 * # Why this lives in tests/invariants/
 *
 * The pre-fix code path was visually simple (one `dataSource.query`
 * line per DDL) and easy to re-introduce by accident in a future
 * refactor. The class also does NOT have a clean type-system boundary
 * preventing DDL — `dataSource.query()` accepts any string. A specific
 * source-text invariant is the right Tier-3 (make-detectable) hedge.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVICE_PATH = resolve(
  REPO_ROOT,
  'libs/backend-common/src/database/tenant-schema-sync.service.ts',
);

// DDL keywords that, if present in this file's executable code, would
// represent a return of the boot-time DDL path. Documentation comments
// frequently mention these keywords as part of the WHY narrative — the
// invariant strips comments before matching.
const FORBIDDEN_DDL_KEYWORDS = [
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'CREATE INDEX',
  'DROP INDEX',
  'ADD COLUMN',
  'DROP COLUMN',
  'CREATE SCHEMA',
  'DROP SCHEMA',
] as const;

/**
 * Strip line and block comments from a TypeScript source file so the
 * invariant matches against EXECUTABLE code only. Documentation
 * blocks legitimately reference DDL keywords as part of explaining
 * the architectural shift away from boot-time DDL.
 */
function stripComments(src: string): string {
  // Remove block comments (/** ... */ and /* ... */) — non-greedy.
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments (// ... to end of line).
  return noBlock.replace(/\/\/[^\n]*/g, '');
}

describe('INVARIANT (DATA-CRITICAL-002 / LEGAL-HIGH-004): TenantSchemaSyncService is read-only', () => {
  let executableSrc: string;

  beforeAll(() => {
    const src = readFileSync(SERVICE_PATH, 'utf8');
    executableSrc = stripComments(src);
  });

  for (const keyword of FORBIDDEN_DDL_KEYWORDS) {
    it(`executable code does NOT contain '${keyword}'`, () => {
      // Case-insensitive scan — DDL keywords are case-insensitive in SQL
      // but project convention is uppercase. We block both spellings.
      expect(executableSrc.toUpperCase()).not.toContain(keyword);
    });
  }

  it('still implements OnApplicationBootstrap (the boot hook is preserved)', () => {
    // The class keeps its OnApplicationBootstrap interface so the 7
    // service AppModules that register it as a provider continue to
    // work without change. Removing the interface would silently turn
    // the boot scan off.
    expect(executableSrc).toMatch(/implements\s+OnApplicationBootstrap/);
    expect(executableSrc).toMatch(/onApplicationBootstrap\s*\(/);
  });

  it('only uses SELECT statements in dataSource.query calls', () => {
    // Every `this.dataSource.query(` call should be followed (within the
    // same template literal) by a SELECT or SHOW statement. The grep
    // catches the pattern at the syntactic level — any other SQL verb
    // triggers a fail.
    const queryCalls = executableSrc.matchAll(/this\.dataSource\.query\(\s*[`'"]([^`'"]*?)[`'"]/g);
    for (const match of queryCalls) {
      const sql = (match[1] ?? '').trim().toUpperCase();
      const firstWord = sql.split(/\s+/)[0];
      expect(['SELECT', 'SHOW', 'WITH']).toContain(firstWord);
    }
  });
});
