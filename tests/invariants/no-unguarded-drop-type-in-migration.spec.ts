import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  findUnguardedSharedEnumDrop,
  isTenantAwareMigrationName,
  tenantAwareMigrationDirs,
} from '../../tools/gates/migration-shared-enum-drop';

/**
 * Bans an unguarded `DROP TYPE` in the `up()` of a tenant-aware migration
 * (production outage 2026-07-07, `DropHarvestQualityGrade1804300000000`).
 *
 * The rule — what a shared source-schema enum is, why dropping it in `up()`
 * aborts db-migrate's source-first fan-out, and the only sanctioned reclamation
 * (a `pg_depend` "no dependents remain" gate PLUS a `SHARED-ENUM-DROP-REVIEWED`
 * annotation) — lives in ONE owner, `tools/gates/migration-shared-enum-drop.ts`.
 * This spec fails the build on it; ARIA's `sql-migration-safety-adapter`
 * observes the same verdict (ARIA-HIGH-011). The tenant-aware directories are
 * derived there from the platform catalog's `migrationGlobs`, never a
 * hand-copied service list (ORPHAN-HIGH-406).
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

function migrationFiles(): string[] {
  const files: string[] = [];
  for (const relDir of tenantAwareMigrationDirs()) {
    const dir = join(REPO_ROOT, relDir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (isTenantAwareMigrationName(entry)) files.push(join(dir, entry));
    }
  }
  return files;
}

describe('tenant-aware migrations do not drop a shared enum type in up()', () => {
  it('no unguarded DROP TYPE in any tenant-aware migration up()', () => {
    const violations: string[] = [];

    for (const file of migrationFiles()) {
      if (findUnguardedSharedEnumDrop(readFileSync(file, 'utf8')) !== null) {
        violations.push(relative(REPO_ROOT, file));
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Unguarded DROP TYPE in the up() of ${violations.length} tenant-aware migration(s):\n  ` +
          violations.join('\n  ') +
          `\nA source-schema enum is a single shared type that every tenant clone ` +
          `cross-references (CREATE TABLE LIKE does not clone types), so DROP TYPE ` +
          `aborts db-migrate in the source-first fan-out → total outage ` +
          `(DropHarvestQualityGrade1804300000000, 2026-07-07). Drop the COLUMN and ` +
          `LEAVE the orphaned enum, or gate the drop on a pg_depend ` +
          `"no dependents remain" check + a SHARED-ENUM-DROP-REVIEWED annotation.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
