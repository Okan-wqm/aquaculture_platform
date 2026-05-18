/**
 * Platform-wide invariant — KERNEL-CRITICAL-001:
 *
 * **No migration body may issue a `SAVEPOINT` statement without an
 * explicit `-- ALLOWS-SAVEPOINT:` marker.**
 *
 * # WHY
 *
 * SAVEPOINT-per-statement is the **silent-rollback class** that caused
 * the 2026-04 HR drift incident.
 *
 * Quote from `apps/hr-service/src/database/migrations/1786900000000-HealHrEnumTypeDrift.ts:14-15`:
 *
 *   > "SAVEPOINT-per-statement band-aid (commit 5df00179) swallowed the ALTER"
 *
 * Inside a migration's `up()`, code patterns like:
 *
 *   ```typescript
 *   await queryRunner.query('SAVEPOINT step_1');
 *   try {
 *     await queryRunner.query('ALTER TABLE foo …');
 *     await queryRunner.query('RELEASE SAVEPOINT step_1');
 *   } catch {
 *     await queryRunner.query('ROLLBACK TO SAVEPOINT step_1');
 *   }
 *   ```
 *
 * appear to make a migration "idempotent" but **the outer migration
 * transaction commits even when individual SAVEPOINT-wrapped steps roll
 * back**. TypeORM's `MigrationExecutor` then INSERTs a row into
 * `_migrations` (ledger says "applied"), but the physical DDL never
 * landed. The next deploy sees no pending migration and ships a service
 * pointing at an entity surface that does not exist in the DB.
 *
 * This is the formal CLAUDE.md "Inviolable rules" #1 violation — ledger
 * says applied, DB says lagged. Faz 1 of the day-one reset closes this
 * class architecturally:
 *
 *   - This invariant: source-level guard. New migrations cannot ship
 *     a SAVEPOINT without the marker.
 *
 *   - (Planned) `MigrationRunnerService` post-condition probe: after
 *     `executeMigration()` returns, the runner re-queries
 *     `information_schema` for the entities touched by the migration
 *     and refuses to write the ledger row if drift remains.
 *
 * # MARKER
 *
 * The `-- ALLOWS-SAVEPOINT: <reason>` comment marker exempts a
 * migration from this check. Use cases are intentionally narrow:
 *
 *   - PL/pgSQL DO blocks that use SAVEPOINT for **idempotency in a
 *     CREATE-OR-REPLACE pattern** where the only failure mode is
 *     duplicate-object (e.g. `EXCEPTION WHEN duplicate_object` blocks
 *     already covered by R5 in migration-sql-lint).
 *
 *   - Long-running data backfills that must continue past per-row
 *     errors (rare; usually backfill is a separate one-off script,
 *     not a migration).
 *
 * In both cases the migration MUST also assert the post-condition at
 * the end of `up()` (e.g. SELECT count + raise EXCEPTION if mismatch).
 *
 * # GRANDFATHERED HISTORICAL MIGRATIONS
 *
 * Two HR migrations carry SAVEPOINT-per-statement as **anti-pattern
 * artefacts** that the day-one reset will erase:
 *
 *   - `apps/hr-service/src/database/migrations/1786800000000-SyncHrEntitiesToDb.ts`
 *   - `apps/hr-service/src/database/migrations/1786900000000-HealHrEnumTypeDrift.ts`
 *
 * Both are grandfathered until Faz 3 baseline reset. After the reset,
 * the grandfather list is emptied.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const GRANDFATHERED: ReadonlySet<string> = new Set([
  'apps/hr-service/src/database/migrations/1786800000000-SyncHrEntitiesToDb.ts',
  'apps/hr-service/src/database/migrations/1786900000000-HealHrEnumTypeDrift.ts',
]);

const SAVEPOINT_MARKER_RE = /--\s*ALLOWS-SAVEPOINT:\s*\S+/i;
const SAVEPOINT_USAGE_RE = /\bSAVEPOINT\b/i;

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
    .filter((p) => !p.includes('.archive/'))
    .filter((p) => !p.endsWith('.spec.ts'))
    .filter((p) => !p.endsWith('.test.ts'));
}

describe('INVARIANT — no SAVEPOINT in migration bodies (KERNEL-CRITICAL-001)', () => {
  const files = listMigrationFiles();

  it('repository contains migration files to scan', () => {
    // Post-ADR-030 (day-one reset) the archived pre-baseline chain is
    // excluded from this scan. 14 consolidated baselines + post-reset
    // add-ons remain; >10 is a sanity floor.
    expect(files.length).toBeGreaterThan(10);
  });

  it('no NEW migration uses SAVEPOINT without -- ALLOWS-SAVEPOINT: marker', () => {
    const violations: Array<{ file: string; line: string }> = [];

    for (const relativePath of files) {
      if (GRANDFATHERED.has(relativePath)) continue;

      const fullPath = resolve(REPO_ROOT, relativePath);
      const src = readFileSync(fullPath, 'utf8');

      if (!SAVEPOINT_USAGE_RE.test(src)) continue;

      // SAVEPOINT mention is OK if the file declares the marker.
      if (SAVEPOINT_MARKER_RE.test(src)) continue;

      // Find the first occurrence line to report.
      const idx = src.search(SAVEPOINT_USAGE_RE);
      const start = src.lastIndexOf('\n', idx) + 1;
      const end = src.indexOf('\n', idx);
      const line = src
        .slice(start, end === -1 ? undefined : end)
        .trim()
        .slice(0, 200);

      violations.push({ file: relativePath, line });
    }

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.file}\n      line: ${v.line}`)
        .join('\n');
      throw new Error(
        `SAVEPOINT detected in migration body without marker:\n${detail}\n\n` +
          `Resolution:\n` +
          `  1. Remove the SAVEPOINT — restructure as full per-migration tx.\n` +
          `  2. Otherwise, add a comment in the migration body:\n` +
          `       -- ALLOWS-SAVEPOINT: <reason>\n` +
          `  3. Add a post-condition assertion at end of up() that verifies\n` +
          `     the DDL actually landed (information_schema lookup + raise EXCEPTION).\n` +
          `  4. Review with architectural-arbiter (CODEOWNERS).`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  it('grandfathered HR migrations exist (sanity)', () => {
    for (const p of GRANDFATHERED) {
      const fullPath = resolve(REPO_ROOT, p);
      // ENOENT is fine in the post-baseline-reset world — the grandfather
      // entry just becomes a no-op. Assertion lives to confirm pre-reset
      // baseline state for clarity.
      try {
        const src = readFileSync(fullPath, 'utf8');
        expect(SAVEPOINT_USAGE_RE.test(src)).toBe(true);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code !== 'ENOENT') throw err;
      }
    }
  });
});
